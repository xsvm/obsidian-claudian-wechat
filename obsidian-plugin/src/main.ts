import { Plugin, FileSystemAdapter, Notice } from 'obsidian';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import { RelayManager } from './relayManager';
import { WeChatBridgeSettingTab } from './settingsTab';

/**
 * WeChat Bridge
 *
 * Local-only HTTP server that drives the installed Claudian plugin
 * (id: "realclaudian") the same way its own UI does:
 *   - chat text                -> InputController.sendMessage({ content }) on a dedicated tab
 *   - /model X /effort X /permission X -> plugin.mutateSettings() + UI refresh
 *   - /list                    -> list known conversations (from .claudian/sessions/*.meta.json)
 *   - /switch N                -> point the bridge's tab at conversation #N from the last /list
 *   - /new                     -> detach from the current conversation; next message starts a fresh one
 *   - /commands                -> list Claude's own slash commands (TabManager.getSdkCommands)
 *   - anything else starting with "/" that isn't one of the above is passed through
 *     as a normal chat message, so Claude's own slash commands (/compact, vault
 *     commands under .claude/commands, skills, etc.) already work by just typing
 *     them; /commands only exists to make them discoverable from WeChat, where
 *     there is no "/" autocomplete dropdown to look at.
 *
 * All bridge-authored text (help, list, confirmations, errors) is bilingual and
 * picked at request time from Claudian's own `locale` setting, so switching
 * Claudian's UI language switches this bridge's replies too.
 *
 * This plugin never talks to WeChat directly. An external relay process
 * (handling the WeChat ClawBot ilink protocol) POSTs plain text here and
 * reads back a reply as JSON.
 */

const PREFERRED_PORT = 39217;
const MAX_PORT_ATTEMPTS = 20; // preferred port + up to 19 fallbacks if it's taken
const CLAUDIAN_PLUGIN_ID = 'realclaudian';
const VIEW_TYPE_CLAUDIAN = 'claudian-view';

// Every provider Claudian ships. `claude` has no `enabled` flag in its own
// registration (ProviderRegistry: `isEnabled: () => true`) - it's always on;
// the others are opt-in and expose `providerConfigs.<id>.enabled` in
// Claudian's settings, matching each provider's own registration.ts.
const ALL_PROVIDER_IDS = ['claude', 'codex', 'opencode', 'pi', 'grok'] as const;
type ProviderId = (typeof ALL_PROVIDER_IDS)[number];

/** Inbound image payload as sent by relay.py's /message POST body. */
interface IncomingImage {
  mediaType: string;
  data: string; // base64, no "data:" prefix
}

interface BridgeData {
  conversationId: string | null;
  /** conversation ids in the order shown by the last /list, for /switch N to index into. */
  lastListedIds: string[];
  /** /listen on|off: mirror turns sent from the desktop Claudian UI to WeChat too. */
  listening: boolean;
  /**
   * The conversation /listen was turned on for. Scoped, not global: switching
   * to a different conversation (via /switch or /new) after turning listening
   * on must NOT keep mirroring the new one - checkForDesktopActivity() only
   * acts while this still matches the currently bound conversationId. `null`
   * means "turned on before any conversation existed yet" - it then binds to
   * whichever conversation actually gets created by the next message, same as
   * conversationId itself starts out null and gets filled in lazily.
   */
  listeningConversationId: string | null;
  /** Message count already seen in the bound tab, so the /listen poller only reports new turns. */
  lastSeenMessageCount: number;
  /**
   * Provider to use for the *next* new conversation (set via /provider).
   * Irrelevant once bound to a conversation - that conversation's own
   * providerId (from its session metadata) always wins; Claudian doesn't
   * allow changing a bound conversation's provider anyway.
   */
  providerId: ProviderId | null;
}

// ---- Minimal shape of the parts of Claudian we reach into at runtime. ----
// These are not Claudian's declared public API; they are the same fields/
// methods Claudian's own UI code uses internally (verified against source).
type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolId: string }
  | { type: 'thinking'; content: string; durationSeconds?: number }
  | { type: 'subagent'; subagentId: string }
  | { type: 'context_compacted' };

interface ClaudianChatMessage {
  role: 'user' | 'assistant';
  content: string;
  contentBlocks?: ContentBlock[];
}

interface ClaudianSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** Shape Claudian's own paste/drop image-attachment code builds (ImageContextManager.addImageFromFile) -
 * `sendMessage`'s `images` option is a plain array of these, verified against the same call site
 * (`this.sendMessage({content, images, turnRequestOverride})`) that the queued-message replay path uses. */
interface ClaudianImageAttachment {
  id: string;
  name: string;
  mediaType: string;
  data: string; // base64, no "data:" prefix
  size: number;
  source: string;
}

interface ClaudianTab {
  id: string;
  conversationId: string | null;
  lifecycleState: string;
  controllers: {
    inputController: {
      sendMessage(opts: { content: string; images?: ClaudianImageAttachment[] }): Promise<void>;
    } | null;
  };
  state: {
    messages: ClaudianChatMessage[];
    /** True for the whole duration of a turn (set at the start of
     * executeSendMessage, cleared when it finishes/errors/cancels) - the
     * actual "is this tab still generating" signal, shared by every
     * provider's UI-level state class. */
    isStreaming: boolean;
  };
  ui: {
    /** FileContextManager.autoAttachActiveFile() listens for Obsidian's global
     * `file-open` workspace event and marks *whatever file the user currently
     * has open, in any pane* as this tab's "current note" - completely
     * independent of what conversation the tab is bound to, or who's actually
     * about to send a message in it. `shouldSendCurrentNote()` then silently
     * folds that note in as `<linked_note>` context on the tab's next send,
     * once, until `markCurrentNoteSent()` clears the pending flag. For a
     * bridge-driven tab nobody is looking at, this means whatever note
     * happens to be open on the user's screen at that moment rides along on
     * the next WeChat message with no way to notice from WeChat itself. */
    fileContextManager: { markCurrentNoteSent(): void } | null;
  };
}

interface ClaudianTabManager {
  getAllTabs(): ClaudianTab[];
  /**
   * `options.defaultProviderId`, for a brand-new blank tab (no conversationId),
   * makes Claudian pick that provider's own saved default model
   * (`resolveBlankTabModel` -> `ProviderSettingsCoordinator.getProviderSettingsSnapshot`)
   * instead of inheriting whatever provider the currently active tab happens
   * to use - this is how the bridge opens a new conversation on a specific
   * non-default provider without having to guess a model name itself.
   */
  createTab(conversationId?: string, tabId?: string, options?: { defaultProviderId?: string }): Promise<ClaudianTab>;
  getSdkCommands(tabId?: string): Promise<ClaudianSlashCommand[]>;
}

interface ClaudianView {
  getTabManager?(): ClaudianTabManager | null;
  refreshModelSelector?(): void;
}

interface ClaudianPluginInstance {
  settings: Record<string, any>;
  mutateSettings(mutation: (settings: Record<string, any>) => void): Promise<void>;
  getAllViews?(): ClaudianView[];
}

interface ConversationMeta {
  id: string;
  title?: string;
  updatedAt?: number;
  providerId?: string;
  usage?: { contextTokens?: number; contextWindow?: number };
}

// ---- i18n ----
// Language is decided per-request from Claudian's own `settings.locale`
// (e.g. "zh-CN", "en"), not from any setting of this plugin's own.
type Lang = 'zh' | 'en';

const STRINGS = {
  emptyText: { zh: '消息内容为空', en: 'Empty text' },
  bodyMustBeJson: { zh: '请求体必须是 JSON: {"text": "..."}', en: 'Body must be JSON: {"text": "..."}' },
  tabNotReady: {
    zh: 'Claudian 会话标签页还没准备好（没有 inputController），请稍后重试。',
    en: 'Claudian tab is not ready yet (no inputController). Retry shortly.',
  },
  noViewOpen: {
    zh: '没有打开的 Claudian 视图，请先在 Obsidian 里打开一次 Claudian 侧边栏。',
    en: 'No Claudian view is open. Open the Claudian sidebar once.',
  },
  noTabManager: { zh: 'Claudian 的 tab manager 不可用。', en: 'Claudian tab manager not available.' },
  tabLimitReached: {
    zh: 'Claudian 标签页已达上限(10个),无法为桥接创建新标签页。请在桌面端关闭一个标签页后重试。',
    en: 'Claudian has hit its hard tab limit (10) and could not create a tab for the bridge. Close a tab in the desktop UI and try again.',
  },
  pluginNotEnabled: {
    zh: (id: string) => `Claudian 插件（"${id}"）未启用。`,
    en: (id: string) => `Claudian plugin ("${id}") is not enabled.`,
  },
  noConversations: { zh: '没有找到任何会话。', en: 'No conversations found.' },
  untitled: { zh: '(无标题)', en: '(untitled)' },
  current: { zh: ' (当前)', en: ' (current)' },
  switchNeedsListFirst: {
    zh: '请先发送 /list 查看会话列表，再用 /switch 序号 切换。',
    en: 'Send /list first to see the conversation list, then use /switch <number>.',
  },
  switchedTo: { zh: (title: string) => `已切换到: ${title}`, en: (title: string) => `Switched to: ${title}` },
  newConversationStarted: {
    zh: '已新建对话，下一条消息将开始一个全新的会话。',
    en: 'Started a new conversation; the next message will begin fresh.',
  },
  noDispatchText: {
    zh: '(这一轮没有生成文字回复。Claudian 内部可能报错并回滚了这轮对话——请去 Obsidian 里看一下有没有弹出的提示，或直接重试一次。)',
    en: '(No text reply was generated this turn. Claudian may have errored and rolled the turn back — check Obsidian for a notice, or just retry.)',
  },
  compactedNoText: {
    zh: '已压缩对话上下文（/compact 执行成功，本身就不会有文字回复）。',
    en: 'Conversation context was compacted successfully (/compact has no text reply by design).',
  },
  noClaudeCommands: {
    zh: '没有发现 Claude 自带的斜杠命令（可能还没打开过一次会话）。',
    en: 'No Claude slash commands found (a conversation may not have been opened yet).',
  },
  claudeCommandsHeader: {
    zh: 'Claude 自带的斜杠命令（在这里发送即可直接使用，例如 /compact）:',
    en: "Claude's own slash commands (send them directly, e.g. /compact):",
  },
  statusTemplate: {
    zh: (model: string, effort: string, permission: string) =>
      `当前设置:\n模型: ${model}\n思考强度: ${effort}\n权限模式: ${permission}`,
    en: (model: string, effort: string, permission: string) =>
      `Current settings:\nModel: ${model}\nEffort: ${effort}\nPermission: ${permission}`,
  },
  histEmpty: {
    zh: '当前会话还没有任何消息。',
    en: 'No messages yet in this conversation.',
  },
  histHeader: {
    zh: '历史消息（发送 /hist 序号 查看对应回复）:',
    en: 'Message history (send /hist <number> to view its reply):',
  },
  outOfRange: {
    zh: (n: number) => `序号超出范围（1-${n}）。`,
    en: (n: number) => `Index out of range (1-${n}).`,
  },
  listenOn: {
    zh: '监听已开启（仅对当前对话生效）：在 Claudian 电脑客户端上发的消息也会推送到这里。切换到其他对话后监听不会跟过去。',
    en: 'Listening enabled (scoped to the current conversation only): messages sent from the Claudian desktop client will also be pushed here. Switching to a different conversation stops it from following.',
  },
  listenOff: { zh: '监听已关闭。', en: 'Listening disabled.' },
  listenUsage: {
    zh: '用法: /listen on 或 /listen off',
    en: 'Usage: /listen on or /listen off',
  },
  statusListeningLabel: { zh: '监听: ', en: 'Listening: ' },
  statusListeningOn: { zh: '开启', en: 'on' },
  statusListeningOff: { zh: '关闭', en: 'off' },
  contextWindowLine: {
    zh: (used: string, total: string) => `上下文窗口：${used}/${total}`,
    en: (used: string, total: string) => `Context window: ${used}/${total}`,
  },
  desktopTurnTemplate: {
    zh: (title: string, prompt: string, reply: string) => `对话: ${title}\nprompt：${prompt}\n\n${reply}`,
    en: (title: string, prompt: string, reply: string) => `Conversation: ${title}\nprompt: ${prompt}\n\n${reply}`,
  },
  providerLabel: { zh: '供应商: ', en: 'Provider: ' },
  providerUsage: {
    zh: (enabled: string) => `用法: /provider <名称>\n可用供应商: ${enabled}`,
    en: (enabled: string) => `Usage: /provider <name>\nAvailable providers: ${enabled}`,
  },
  providerUnknown: {
    zh: (name: string, enabled: string) => `不认识的供应商 "${name}"。可用供应商: ${enabled}`,
    en: (name: string, enabled: string) => `Unknown provider "${name}". Available providers: ${enabled}`,
  },
  providerSwitched: {
    zh: (name: string) => `已切换到供应商: ${name}。下一条消息将在这个供应商上开始一个全新的对话。`,
    en: (name: string) => `Switched to provider: ${name}. The next message will start a brand-new conversation on it.`,
  },
} as const;

/** /help text. Only mentions /provider when more than one provider is actually enabled in Claudian. */
function buildHelpText(lang: Lang, showProviderCommand: boolean): string {
  const zh = [
    '本插件命令:',
    '/help — 显示本帮助',
    '/list 或 /ls — 列出历史会话（编号、标题、更新时间）',
    '/switch N 或 /goto N — 切换到 /list 中第 N 个会话',
    '/new — 新建一个全新对话（不影响其他历史会话）',
    '/status — 查看当前模型、思考强度、权限模式、监听状态',
    '/hist — 按序号列出当前对话你发过的消息',
    '/hist N — 查看第 N 条消息对应的回复',
    '/listen on 或 /listen off — 开关监听：开启后，电脑客户端上发的消息也会推送到这里',
    '/model <名称> — 切换模型，如 /model opus、/model sonnet',
    '/effort <等级> — 切换思考强度，如 /effort low、/effort high',
    '/permission <模式> — 切换权限模式，如 /permission yolo、/permission default',
    ...(showProviderCommand ? ['/provider <名称> — 切换供应商（会开始一个新对话），发送 /provider 查看可选项'] : []),
    '/commands — 查看 Claude 自带的斜杠命令（跟上面这些是两回事）',
    '其他任何文字 — 作为普通消息发给 Claudian（Claude 自带的斜杠命令也直接这样发送即可）',
  ];
  const en = [
    'Bridge commands:',
    '/help — show this help',
    '/list or /ls — list past conversations (number, title, updated time)',
    '/switch N or /goto N — switch to conversation number N from /list',
    '/new — start a brand-new conversation (existing ones are untouched)',
    '/status — show the current model, effort level, permission mode, and listening state',
    '/hist — list your messages in the current conversation, numbered',
    '/hist N — show the reply to message number N',
    '/listen on or /listen off — toggle listening: when on, messages sent from the desktop client are pushed here too',
    '/model <name> — switch model, e.g. /model opus, /model sonnet',
    '/effort <level> — switch effort level, e.g. /effort low, /effort high',
    '/permission <mode> — switch permission mode, e.g. /permission yolo, /permission default',
    ...(showProviderCommand ? ['/provider <name> — switch provider (starts a new conversation); send /provider alone to see options'] : []),
    "/commands — list Claude's own slash commands (separate from the bridge commands above)",
    'anything else — sent to Claudian as a normal message (this is also how you use ‘Claude’s own slash commands themselves)',
  ];
  return (lang === 'zh' ? zh : en).join('\n');
}

function pick<T>(entry: { zh: T; en: T }, lang: Lang): T {
  return entry[lang];
}

const DEFAULT_DATA: BridgeData = {
  conversationId: null,
  lastListedIds: [],
  listening: false,
  listeningConversationId: null,
  lastSeenMessageCount: 0,
  providerId: null,
};

const LISTEN_POLL_INTERVAL_MS = 3000;

export default class WeChatBridgePlugin extends Plugin {
  private server: http.Server | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private data: BridgeData = { ...DEFAULT_DATA };
  /** Pushes queued by the /listen poller, drained by the relay's /pending polling. */
  private pendingPushes: string[] = [];
  /** True while this plugin's own sendChatMessage() is driving a turn, so the
   * /listen poller does not mistake a WeChat-originated turn for a desktop one. */
  private sendingViaBridge = false;
  private relayManager: RelayManager | null = null;
  private pluginDir: string | null = null;

  async onload() {
    const saved = await this.loadData();
    this.data = { ...DEFAULT_DATA, ...(saved ?? {}) };

    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      this.pluginDir = path.join(adapter.getBasePath(), this.manifest.dir ?? '.obsidian/plugins/wechat-bridge');
    }

    // Must finish (and, if it had to fall back to a non-default port, write
    // port.txt) before the relay is started, since relay.py reads that file
    // to know where to send messages.
    await this.startServer();

    this.registerInterval(window.setInterval(() => this.checkForDesktopActivity(), LISTEN_POLL_INTERVAL_MS));

    // Owns the whole "get connected" path so installing this plugin is enough
    // on its own: private Python env, one-time QR login, and the relay
    // process itself, all tied to this plugin's own lifetime. Runs in the
    // background; failures surface as Notices rather than blocking onload().
    if (this.pluginDir) {
      this.relayManager = new RelayManager(this.app, this.pluginDir);
      void this.relayManager.ensureRunning();
    }

    this.addSettingTab(new WeChatBridgeSettingTab(this.app, this));
  }

  async onunload() {
    this.server?.close();
    this.server = null;
    this.relayManager?.stop();
  }

  /** Exposed for the settings tab (connection status, QR reconnect, restart/disconnect). */
  getRelayManager(): RelayManager | null {
    return this.relayManager;
  }

  /**
   * Binds the HTTP server, trying PREFERRED_PORT first and a handful of
   * fallbacks after it if that's already taken by something else on this
   * machine. Whichever port actually succeeds is written to `port.txt` next
   * to relay.py, which reads it on startup instead of assuming 39217 - so a
   * busy port degrades to "still works, just not on the default port"
   * instead of the whole bridge silently never coming up.
   */
  private async startServer(): Promise<void> {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/pending') {
        const pushes = this.pendingPushes;
        this.pendingPushes = [];
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        // `listening` lets the relay back off its poll rate while /listen is
        // off, instead of hitting this endpoint at a fixed interval forever
        // regardless of whether the feature is even in use.
        res.end(JSON.stringify({ ok: true, pushes, listening: this.data.listening }));
        return;
      }

      if (req.method !== 'POST' || req.url !== '/message') {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      req.on('end', () => {
        // Concatenate raw bytes before decoding so a multi-byte UTF-8
        // character split across two TCP chunks never gets mis-decoded.
        const body = Buffer.concat(chunks).toString('utf8');
        // Serialize handling so concurrent WeChat messages don't race the
        // same tab/session.
        this.busy = this.busy
          .then(() => this.handleIncoming(body))
          .then(
            (reply) => {
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: true, reply }));
            },
            (err) => {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
            },
          );
      });
    });

    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      const candidate = PREFERRED_PORT + attempt;
      // eslint-disable-next-line no-await-in-loop
      const bound = await this.tryListen(server, candidate);
      if (bound) {
        this.server = server;
        if (this.pluginDir) {
          await fs.writeFile(path.join(this.pluginDir, 'port.txt'), String(candidate), 'utf-8').catch(() => {});
        }
        if (attempt > 0) {
          new Notice(`WeChat Bridge: port ${PREFERRED_PORT} was in use; using ${candidate} instead.`);
        }
        return;
      }
    }

    new Notice(
      `WeChat Bridge: could not bind any port in ${PREFERRED_PORT}-${PREFERRED_PORT + MAX_PORT_ATTEMPTS - 1}. ` +
      'The bridge is not running - free up one of those ports and reload the plugin.',
      20000,
    );
  }

  /** Resolves true if `server.listen(port, ...)` succeeded, false on EADDRINUSE (or any other bind error). */
  private tryListen(server: http.Server, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const onError = () => {
        server.removeListener('listening', onListening);
        resolve(false);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  }

  private async handleIncoming(rawBody: string): Promise<string> {
    let text: string;
    // Optional inbound image (relay.py downloads+decrypts the WeChat CDN blob
    // and base64-encodes it before POSTing here - see IncomingImage below).
    let image: IncomingImage | undefined;
    try {
      const parsed = JSON.parse(rawBody);
      text = String(parsed.text ?? '').trim();
      if (
        parsed.image
        && typeof parsed.image.data === 'string'
        && typeof parsed.image.mediaType === 'string'
      ) {
        image = { data: parsed.image.data, mediaType: parsed.image.mediaType };
      }
    } catch {
      throw new Error(pick(STRINGS.bodyMustBeJson, this.getLangSafe()));
    }
    const lang = this.getLangSafe();
    // A pure image message (no caption) has empty text - only reject the
    // request if there's neither text nor an image to act on.
    if (!text && !image) throw new Error(pick(STRINGS.emptyText, lang));

    if (/^\/help\b/i.test(text)) {
      return buildHelpText(lang, this.getEnabledProviders().length > 1);
    }

    if (/^\/commands\b/i.test(text)) {
      return await this.listClaudeCommands(lang);
    }

    const settingsCmd = this.parseSettingsCommand(text);
    if (settingsCmd) {
      return await this.applySettingsCommand(settingsCmd.key, settingsCmd.value, lang);
    }

    const providerMatch = text.match(/^\/provider\s+(\S+)/i);
    if (providerMatch) {
      return await this.switchProvider(providerMatch[1].toLowerCase(), lang);
    }
    if (/^\/provider\b/i.test(text)) {
      return pick(STRINGS.providerUsage, lang)(this.getEnabledProviders().join(', '));
    }

    if (/^\/(list|ls)\b/i.test(text)) {
      return this.listConversations(lang);
    }

    const switchMatch = text.match(/^\/(switch|goto)\s+(\d+)/i);
    if (switchMatch) {
      return await this.switchConversation(Number(switchMatch[2]), lang);
    }

    if (/^\/status\b/i.test(text)) {
      return this.statusText(lang);
    }

    const histMatch = text.match(/^\/hist(?:\s+(\d+))?\b/i);
    if (histMatch) {
      return histMatch[1]
        ? await this.showHistory(Number(histMatch[1]), lang)
        : await this.listHistory(lang);
    }

    const listenMatch = text.match(/^\/listen\s+(on|off)\b/i);
    if (listenMatch) {
      return await this.setListening(listenMatch[1].toLowerCase() === 'on', lang);
    }
    if (/^\/listen\b/i.test(text)) {
      return pick(STRINGS.listenUsage, lang);
    }

    if (/^\/new\b/i.test(text)) {
      this.data.conversationId = null;
      await this.saveData(this.data);
      return pick(STRINGS.newConversationStarted, lang);
    }

    // Everything else - including Claude's own slash commands like /compact,
    // vault commands, and skills - is sent through as-is. Claudian's own
    // InputController already detects and expands those; this bridge does
    // not need to special-case them.
    return await this.sendChatMessage(text, lang, image);
  }

  // ---- locale ----

  private getLangSafe(): Lang {
    try {
      const locale = this.getClaudianPlugin().settings?.locale;
      return typeof locale === 'string' && locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    } catch {
      return 'en';
    }
  }

  // ---- Claude's own slash commands (discovery only; sending them is just a normal message) ----

  private async listClaudeCommands(lang: Lang): Promise<string> {
    const tab = await this.getOrCreateWeChatTab();
    const view = (this.getClaudianPlugin().getAllViews?.() ?? [])[0] ?? this.findClaudianViewViaWorkspace();
    const tabManager = view?.getTabManager?.();
    if (!tabManager) throw new Error(pick(STRINGS.noTabManager, lang));

    const commands = await tabManager.getSdkCommands(tab.id);
    if (commands.length === 0) return pick(STRINGS.noClaudeCommands, lang);

    const lines: string[] = [pick(STRINGS.claudeCommandsHeader, lang)];
    for (const cmd of commands) {
      const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
      const desc = cmd.description ? ` — ${cmd.description}` : '';
      lines.push(`/${cmd.name}${hint}${desc}`);
    }
    return lines.join('\n');
  }

  // ---- settings commands: /model, /effort, /permission ----

  private parseSettingsCommand(text: string): { key: 'model' | 'effortLevel' | 'permissionMode'; value: string } | null {
    const match = text.match(/^\/(model|effort|permission)\s+(\S+)/i);
    if (!match) return null;
    const [, cmd, value] = match;
    const key = cmd.toLowerCase() === 'model'
      ? 'model'
      : cmd.toLowerCase() === 'effort'
        ? 'effortLevel'
        : 'permissionMode';
    return { key, value };
  }

  private async applySettingsCommand(
    key: 'model' | 'effortLevel' | 'permissionMode',
    value: string,
    lang: Lang,
  ): Promise<string> {
    const claudian = this.getClaudianPlugin();
    const savedKey = key === 'model'
      ? 'savedProviderModel'
      : key === 'effortLevel'
        ? 'savedProviderEffort'
        : 'savedProviderPermissionMode';

    const metas = await this.readAllConversationMeta();
    const providerId = this.resolveActiveProviderId(metas);

    // Mirrors ProviderSettingsCoordinator.commitProviderSettingsSnapshot: the
    // savedProviderX map is written unconditionally (every provider's last
    // value is always remembered), but the flat field - what Claudian's own
    // UI is showing *right now* - is only overwritten when the provider this
    // command targets is the one currently active in settings.settingsProvider.
    // Otherwise we'd silently change what the Claudian sidebar displays for a
    // provider you're not even looking at.
    await claudian.mutateSettings((settings) => {
      if (!settings[savedKey] || typeof settings[savedKey] !== 'object') {
        settings[savedKey] = {};
      }
      settings[savedKey][providerId] = value;
      if (providerId === (settings.settingsProvider ?? 'claude')) {
        settings[key] = value;
      }
    });

    for (const view of claudian.getAllViews?.() ?? []) {
      view.refreshModelSelector?.();
    }

    const label = lang === 'zh' ? '已设置' : 'OK';
    const providerSuffix = this.getEnabledProviders().length > 1
      ? `${pick(STRINGS.providerLabel, lang)}${providerId}, `
      : '';
    return `${label}: ${providerSuffix}${key} -> ${value}`;
  }

  // ---- provider selection (only relevant for users with more than one Claudian provider enabled) ----

  /** Every provider id Claudian actually has enabled right now. `claude` has no on/off switch - it's always enabled. */
  private getEnabledProviders(): ProviderId[] {
    const configs = this.getClaudianPlugin().settings?.providerConfigs ?? {};
    return ALL_PROVIDER_IDS.filter((id) => id === 'claude' || configs[id]?.enabled === true);
  }

  /**
   * The provider a settings command or a new conversation should target:
   * the bound conversation's own provider (from its session metadata) if
   * there is one - Claudian doesn't allow changing a bound conversation's
   * provider anyway - otherwise whatever /provider last selected for the
   * next new conversation, defaulting to claude.
   */
  private resolveActiveProviderId(metas: ConversationMeta[]): ProviderId {
    if (this.data.conversationId) {
      const meta = metas.find((m) => m.id === this.data.conversationId);
      if (meta?.providerId && (ALL_PROVIDER_IDS as readonly string[]).includes(meta.providerId)) {
        return meta.providerId as ProviderId;
      }
    }
    return this.data.providerId ?? 'claude';
  }

  private async switchProvider(name: string, lang: Lang): Promise<string> {
    const enabled = this.getEnabledProviders();
    if (!(enabled as string[]).includes(name)) {
      return pick(STRINGS.providerUnknown, lang)(name, enabled.join(', '));
    }
    this.data.providerId = name as ProviderId;
    // A bound conversation's provider can't be changed after the fact
    // (Claudian itself rejects that from its own UI); switching provider
    // here always means "start fresh", same as /new.
    this.data.conversationId = null;
    await this.saveData(this.data);
    return pick(STRINGS.providerSwitched, lang)(name);
  }

  // ---- conversation list / switch / new ----

  private getSessionsDir(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('Vault is not on a local filesystem.');
    }
    return path.join(adapter.getBasePath(), '.claudian', 'sessions');
  }

  /**
   * Reads `.claudian/sessions/*.meta.json` asynchronously (fs/promises), so a
   * large, ever-growing session history never blocks Obsidian's renderer
   * thread the way synchronous fs calls would.
   *
   * Result is cached in memory for `META_CACHE_TTL_MS`: within that window,
   * repeat callers (e.g. /switch reading the title right after /list already
   * scanned the same directory, or the /listen poller looking up a title on
   * every push) reuse the same read instead of re-scanning disk.
   */
  private metaCache: { at: number; metas: ConversationMeta[] } | null = null;
  private static readonly META_CACHE_TTL_MS = 5000;

  private async readAllConversationMeta(): Promise<ConversationMeta[]> {
    if (this.metaCache && Date.now() - this.metaCache.at < WeChatBridgePlugin.META_CACHE_TTL_MS) {
      return this.metaCache.metas;
    }

    const dir = this.getSessionsDir();
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.meta.json'));
    } catch {
      return [];
    }
    const metas: ConversationMeta[] = [];
    for (const file of files) {
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf-8');
        metas.push(JSON.parse(raw));
      } catch {
        // skip unreadable/corrupt meta file
      }
    }
    metas.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    this.metaCache = { at: Date.now(), metas };
    return metas;
  }

  private async listConversations(lang: Lang): Promise<string> {
    const metas = await this.readAllConversationMeta();
    this.data.lastListedIds = metas.map((m) => m.id);
    void this.saveData(this.data);

    if (metas.length === 0) return pick(STRINGS.noConversations, lang);

    const localeTag = lang === 'zh' ? 'zh-CN' : 'en-US';
    const lines = metas.map((m, i) => {
      const marker = m.id === this.data.conversationId ? pick(STRINGS.current, lang) : '';
      const when = m.updatedAt ? new Date(m.updatedAt).toLocaleString(localeTag) : '';
      return `${i + 1}. ${m.title || pick(STRINGS.untitled, lang)}${marker} — ${when}`;
    });
    return lines.join('\n');
  }

  private async switchConversation(index: number, lang: Lang): Promise<string> {
    const ids = this.data.lastListedIds;
    if (ids.length === 0) return pick(STRINGS.switchNeedsListFirst, lang);
    const id = ids[index - 1];
    if (!id) return pick(STRINGS.outOfRange, lang)(ids.length);

    this.data.conversationId = id;
    await this.saveData(this.data);

    // Eagerly resolve/open the tab now so the switch fails fast if something's wrong,
    // instead of silently failing on the next chat message.
    const tab = await this.getOrCreateWeChatTab();
    const metas = await this.readAllConversationMeta();
    const title = metas.find((m) => m.id === tab.conversationId)?.title ?? id;
    return pick(STRINGS.switchedTo, lang)(title);
  }

  // ---- status: current model / effort / permission / listening ----

  private async statusText(lang: Lang): Promise<string> {
    const settings = this.getClaudianPlugin().settings ?? {};
    const metas = await this.readAllConversationMeta();
    const providerId = this.resolveActiveProviderId(metas);
    // The flat fields (settings.model etc.) only reflect whichever provider
    // is currently shown in Claudian's own UI (settings.settingsProvider);
    // for any other provider, its last value lives in the savedProviderX map
    // instead (see applySettingsCommand for the same distinction on write).
    const isActiveInUi = providerId === (settings.settingsProvider ?? 'claude');
    const model = isActiveInUi ? settings.model : settings.savedProviderModel?.[providerId];
    const effort = isActiveInUi ? settings.effortLevel : settings.savedProviderEffort?.[providerId];
    const permission = isActiveInUi ? settings.permissionMode : settings.savedProviderPermissionMode?.[providerId];

    const base = pick(STRINGS.statusTemplate, lang)(
      String(model ?? '?'),
      String(effort ?? '?'),
      String(permission ?? '?'),
    );
    const providerLine = this.getEnabledProviders().length > 1
      ? `\n${pick(STRINGS.providerLabel, lang)}${providerId}`
      : '';
    const listeningWord = this.data.listening
      ? pick(STRINGS.statusListeningOn, lang)
      : pick(STRINGS.statusListeningOff, lang);
    return `${base}${providerLine}\n${pick(STRINGS.statusListeningLabel, lang)}${listeningWord}`;
  }

  // ---- /listen on|off: mirror desktop-originated turns to WeChat ----

  private async setListening(on: boolean, lang: Lang): Promise<string> {
    this.data.listening = on;
    if (on) {
      // Scoped to whichever conversation is currently bound - switching to a
      // different one afterward (via /switch or /new) must not carry this
      // along; checkForDesktopActivity() checks this against the live
      // conversationId on every tick. `null` here just means "no conversation
      // yet"; it gets filled in the first time one actually exists (see
      // checkForDesktopActivity and sendChatMessage, which both write
      // data.conversationId once Claudian assigns one).
      this.data.listeningConversationId = this.data.conversationId;
      // Baseline against the bound tab's current message count so turning
      // listening on doesn't immediately re-push everything already said.
      // Only look the tab up if a conversation already exists - doing this
      // unconditionally would create a brand-new blank conversation as a side
      // effect of merely toggling /listen on.
      if (this.data.conversationId) {
        try {
          const tab = await this.getOrCreateWeChatTab();
          this.data.lastSeenMessageCount = tab.state.messages.length;
        } catch {
          this.data.lastSeenMessageCount = 0;
        }
      } else {
        this.data.lastSeenMessageCount = 0;
      }
    }
    await this.saveData(this.data);
    return pick(on ? STRINGS.listenOn : STRINGS.listenOff, lang);
  }

  /**
   * Runs on a timer. While listening is on, detects new turns that appeared
   * in the bound tab without going through this plugin's own sendChatMessage()
   * (i.e. typed directly into Claudian's desktop UI) and queues them for the
   * relay to push to WeChat.
   */
  private async checkForDesktopActivity(): Promise<void> {
    if (!this.data.listening || this.sendingViaBridge) return;
    if (!this.data.conversationId) return;

    // Scoped to the conversation /listen was turned on for - switching to a
    // different one (via /switch or /new) afterward must not carry this
    // along, or turning listening on in conversation A would silently start
    // mirroring conversation B just because it happens to be the bound one
    // later. `null` means /listen was turned on before any conversation
    // existed yet; bind it to whichever one shows up first (this only fires
    // once, since it's non-null on every subsequent tick).
    if (this.data.listeningConversationId === null) {
      this.data.listeningConversationId = this.data.conversationId;
      void this.saveData(this.data);
    } else if (this.data.listeningConversationId !== this.data.conversationId) {
      return;
    }

    let tab: ClaudianTab;
    try {
      tab = await this.getOrCreateWeChatTab();
    } catch {
      return; // No Claudian view open yet, or similar transient state; try again next tick.
    }

    const messages = tab.state.messages;

    // `messages.length` is used as a growth counter, but it isn't guaranteed
    // to only grow: /compact and rewind can replace the array with a shorter
    // one. Without this check, a shrink would leave lastSeenMessageCount
    // permanently above the real length, and `messages.length <= lastSeen`
    // would then hold forever - /listen would go silent until enough new
    // messages accumulated to climb back past the old high-water mark. Treat
    // a shrink as "resync to the current end" instead: we can't know which of
    // the remaining messages are "new" after a rewind/compact, so we don't
    // try to reconstruct and push a partial turn - we just stop missing
    // everything that comes after.
    if (messages.length < this.data.lastSeenMessageCount) {
      this.data.lastSeenMessageCount = messages.length;
      void this.saveData(this.data);
      return;
    }

    if (messages.length === this.data.lastSeenMessageCount) return;

    // Growth detected - but Claudian appends the user turn (and the
    // assistant's placeholder message) to `state.messages` the instant the
    // user hits send, then streams text into that same message object as it
    // generates, long before there's any real content in it. An earlier
    // version of this check reported the turn right here, extracted no text
    // from the still-empty placeholder, and immediately pushed the scary
    // "this turn produced no text" message even though the desktop turn was
    // still actively generating - and then tried to infer "done" purely by
    // fingerprinting message content across polls, which added several
    // seconds of pure latency on every single turn and could still misfire.
    //
    // `state.isStreaming` is Claudian's own real signal for this (set true at
    // the start of executeSendMessage, cleared when the turn finishes,
    // errors, or is cancelled - shared by every provider's UI-level state
    // class). Just wait for it to go false instead of guessing from content.
    if (tab.state.isStreaming) return;

    const newMessages = messages.slice(this.data.lastSeenMessageCount);
    this.data.lastSeenMessageCount = messages.length;
    void this.saveData(this.data);

    const promptMsg = newMessages.find((m) => m.role === 'user');
    if (!promptMsg) return; // Pure assistant-only growth (e.g. a resumed stream); nothing new to report.

    const lang = this.getLangSafe();
    const reply = this.extractDispatchText(newMessages, lang);
    const metas = await this.readAllConversationMeta();
    const title = metas.find((m) => m.id === tab.conversationId)?.title ?? tab.conversationId ?? '?';
    const ctxLine = await this.contextWindowLine(tab.conversationId, lang);
    const body = ctxLine ? `${reply}\n\n${ctxLine}` : reply;
    this.pendingPushes.push(pick(STRINGS.desktopTurnTemplate, lang)(title, promptMsg.content.trim(), body));
  }

  // ---- history: list past turns in the current conversation, and view one reply ----

  private getUserMessageIndices(messages: ClaudianChatMessage[]): number[] {
    const indices: number[] = [];
    messages.forEach((m, i) => {
      if (m.role === 'user') indices.push(i);
    });
    return indices;
  }

  private truncate(text: string, max: number): string {
    const flat = text.trim().replace(/\s+/g, ' ');
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
  }

  private formatK(n: number): string {
    return `${Math.round(n / 1000)}k`;
  }

  /** Appended to real turn replies (normal and /listen) so you can see how full the context window is at a glance. */
  private async contextWindowLine(conversationId: string | null, lang: Lang): Promise<string | null> {
    if (!conversationId) return null;
    // Bypass the meta cache: this is read right after a turn just completed,
    // and the whole point is to report that turn's up-to-date usage, not a
    // pre-turn snapshot the cache may still be holding.
    this.metaCache = null;
    const metas = await this.readAllConversationMeta();
    const usage = metas.find((m) => m.id === conversationId)?.usage;
    if (!usage?.contextTokens || !usage?.contextWindow) return null;
    return pick(STRINGS.contextWindowLine, lang)(
      this.formatK(usage.contextTokens),
      this.formatK(usage.contextWindow),
    );
  }

  private async listHistory(lang: Lang): Promise<string> {
    const tab = await this.getOrCreateWeChatTab();
    // Claudian's `messages` getter returns a fresh array copy on every access
    // (ChatState spreads its internal array each time); read it once and
    // reuse the local reference instead of re-invoking the getter per index.
    const messages = tab.state.messages;
    const userIndices = this.getUserMessageIndices(messages);
    if (userIndices.length === 0) return pick(STRINGS.histEmpty, lang);

    const lines: string[] = [pick(STRINGS.histHeader, lang)];
    userIndices.forEach((msgIndex, i) => {
      lines.push(`${i + 1}. ${this.truncate(messages[msgIndex].content, 40)}`);
    });
    return lines.join('\n');
  }

  private async showHistory(index: number, lang: Lang): Promise<string> {
    const tab = await this.getOrCreateWeChatTab();
    const messages = tab.state.messages;
    const userIndices = this.getUserMessageIndices(messages);
    if (userIndices.length === 0) return pick(STRINGS.histEmpty, lang);

    const msgIndex = userIndices[index - 1];
    if (msgIndex === undefined) return pick(STRINGS.outOfRange, lang)(userIndices.length);

    // Same reply-filtering rule as a live turn: only the assistant's final
    // text is shown, from just after this user message up to the next one.
    const nextUserIndex = userIndices[index] ?? messages.length;
    const turnMessages = messages.slice(msgIndex + 1, nextUserIndex);
    return this.extractDispatchText(turnMessages, lang);
  }

  // ---- chat message injection ----

  private async sendChatMessage(text: string, lang: Lang, image?: IncomingImage): Promise<string> {
    const tab = await this.getOrCreateWeChatTab();
    if (!tab.controllers.inputController) {
      throw new Error(pick(STRINGS.tabNotReady, lang));
    }

    this.sendingViaBridge = true;
    try {
      // The user's currently-open note in Obsidian - whatever that happens to
      // be, unrelated to this conversation - would otherwise silently ride
      // along as `<linked_note>` context on this send (see ClaudianTab.ui's
      // fileContextManager doc comment for why). WeChat has no way to see or
      // veto that, so pre-empt it before every bridge-driven send.
      tab.ui.fileContextManager?.markCurrentNoteSent();

      const beforeCount = tab.state.messages.length;
      // Reconstruct the same shape Claudian's own paste/drop handler builds
      // (id/name/mediaType/data/size/source) - inputController.sendMessage
      // doesn't care how an image got attached, only that it matches this shape.
      const images: ClaudianImageAttachment[] | undefined = image
        ? [{
            id: `wechat-${Date.now()}`,
            name: `wechat-image.${image.mediaType.split('/')[1] ?? 'jpg'}`,
            mediaType: image.mediaType,
            data: image.data,
            size: Math.ceil((image.data.length * 3) / 4),
            source: 'wechat',
          }]
        : undefined;
      await tab.controllers.inputController.sendMessage({ content: text, images });

      if (tab.conversationId && tab.conversationId !== this.data.conversationId) {
        this.data.conversationId = tab.conversationId;
      }
      // Keep the /listen poller's baseline in sync so it doesn't re-report
      // the turn this call itself just produced.
      this.data.lastSeenMessageCount = tab.state.messages.length;
      await this.saveData(this.data);

      const newMessages = tab.state.messages.slice(beforeCount);
      const reply = this.extractDispatchText(newMessages, lang);
      const ctxLine = await this.contextWindowLine(tab.conversationId, lang);
      return ctxLine ? `${reply}\n\n${ctxLine}` : reply;
    } finally {
      this.sendingViaBridge = false;
    }
  }

  /**
   * Decide what actually gets sent to WeChat for one turn.
   *
   * Mirrors what community Claude-Code-to-WeChat channel bridges do: forward
   * only the assistant's narrative text, and drop tool_use/thinking/subagent
   * noise. A turn can contain several assistant messages (one per tool-use
   * round-trip); only the `text` content blocks across all of them are
   * user-facing, so those are concatenated in order.
   */
  private extractDispatchText(messages: ClaudianChatMessage[], lang: Lang): string {
    const parts: string[] = [];
    let sawCompactBoundary = false;
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      if (msg.contentBlocks && msg.contentBlocks.length > 0) {
        for (const block of msg.contentBlocks) {
          if (block.type === 'context_compacted') {
            sawCompactBoundary = true;
            continue;
          }
          if (block.type !== 'text') continue;
          const trimmed = block.content.trim();
          if (trimmed) parts.push(trimmed);
        }
      } else {
        // Fallback for providers/messages without structured content blocks.
        const trimmed = msg.content.trim();
        if (trimmed) parts.push(trimmed);
      }
    }
    if (parts.length > 0) return parts.join('\n\n');
    // /compact (and equivalents on other providers) legitimately produce no
    // narrative text on success - the only sign it happened is a
    // context_compacted boundary block. Without this check that success case
    // was indistinguishable from a genuinely empty/errored turn, and got the
    // scary "did this fail?" message below even though nothing went wrong.
    if (sawCompactBoundary) return pick(STRINGS.compactedNoText, lang);
    return pick(STRINGS.noDispatchText, lang);
  }

  private async getOrCreateWeChatTab(): Promise<ClaudianTab> {
    const claudian = this.getClaudianPlugin();
    const view = (claudian.getAllViews?.() ?? [])[0] ?? this.findClaudianViewViaWorkspace();
    if (!view) throw new Error(pick(STRINGS.noViewOpen, this.getLangSafe()));

    const tabManager = view.getTabManager?.();
    if (!tabManager) throw new Error(pick(STRINGS.noTabManager, this.getLangSafe()));

    if (this.data.conversationId) {
      const existing = tabManager.getAllTabs().find((t) => t.conversationId === this.data.conversationId);
      if (existing) return existing;
      // Tab was closed or conversation was never opened in a tab yet; (re)open it.
      await this.ensureTabCapacity(claudian, tabManager);
      const tab = await tabManager.createTab(this.data.conversationId);
      if (!tab) throw new Error(pick(STRINGS.tabLimitReached, this.getLangSafe()));
      return tab;
    }

    // A brand-new blank tab: if /provider selected something other than the
    // default, pass it through so Claudian seeds the tab with *that*
    // provider's own saved model (resolveBlankTabModel) instead of inheriting
    // whatever provider the currently active Claudian tab happens to be on.
    await this.ensureTabCapacity(claudian, tabManager);
    const tab = await tabManager.createTab(
      undefined,
      undefined,
      this.data.providerId ? { defaultProviderId: this.data.providerId } : undefined,
    );
    if (!tab) throw new Error(pick(STRINGS.tabLimitReached, this.getLangSafe()));
    return tab;
  }

  /**
   * TabManager.createTab() silently returns `null` instead of a tab once
   * `tabs.size + pendingTabCreations >= maxTabs` (Claudian's own cap, clamped
   * 3-10 - see main.js's TabManager.createTab). If the bridge's own bound
   * conversation isn't already open as a tab (view was closed/reopened, or
   * this is the very first message) and the user already has `maxTabs` tabs
   * open in the desktop UI, createTab() returns null and the caller crashed
   * with a bare "Cannot read properties of null (reading 'controllers')" -
   * this is what that error actually was. Rather than fail (or silently
   * commandeer one of the user's existing tabs), bump the limit by exactly
   * one slot so the bridge's own tab can be created without disturbing
   * anything the user already has open. No-ops if there's already room, and
   * gives up quietly at Claudian's hard cap of 10 (createTab's own null path
   * still applies then; the caller's null check reports it clearly instead
   * of crashing).
   */
  private async ensureTabCapacity(claudian: ClaudianPluginInstance, tabManager: ClaudianTabManager): Promise<void> {
    const configured = claudian.settings?.maxTabs;
    const maxTabs = typeof configured === 'number' ? Math.max(3, Math.min(10, configured)) : 3;
    if (tabManager.getAllTabs().length < maxTabs) return;
    if (maxTabs >= 10) return;
    await claudian.mutateSettings((settings) => {
      settings.maxTabs = maxTabs + 1;
    });
  }

  private findClaudianViewViaWorkspace(): ClaudianView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    return (leaves[0]?.view as unknown as ClaudianView) ?? null;
  }

  private getClaudianPlugin(): ClaudianPluginInstance {
    const plugin = (this.app as any).plugins?.plugins?.[CLAUDIAN_PLUGIN_ID];
    if (!plugin) throw new Error(pick(STRINGS.pluginNotEnabled, 'en')(CLAUDIAN_PLUGIN_ID));
    return plugin as ClaudianPluginInstance;
  }
}
