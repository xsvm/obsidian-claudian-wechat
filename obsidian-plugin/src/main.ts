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
  /**
   * /progressive on|off: a genuinely global, not conversation-scoped switch
   * (unlike /listen) - it changes *how any bridge-driven send delivers its
   * reply*, for every conversation this bridge talks to, not what it mirrors.
   * When on, each completed narrative-text chunk of a turn is pushed to
   * WeChat as its own message as soon as it settles (see flushProgressive),
   * instead of buffering the whole turn and replying once at the end.
   */
  progressiveReply: boolean;
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
      /** Renders Claudian's inline "AskUserQuestion" widget and resolves with the
       * user's picks. This bridge replaces it per-tab (see installInteractiveHooks)
       * so a question can be answered from WeChat via /answer instead of only from
       * the desktop UI. `input` is the raw tool_use params (shape: `{questions:[...]}`,
       * reverse-engineered from Claudian's own OA widget class - see parseQuestions). */
      handleAskUserQuestion?(input: any, signal?: AbortSignal): Promise<any>;
      /** Renders Claudian's inline command/file/permission approval widget.
       * Replaced the same way, answerable from WeChat via /approve. `kind` is
       * "command_execution" | "file_change" | "permissions". */
      handleApprovalRequest?(kind: string, details: any, title: string, opts: any): Promise<any>;
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

/** One question from an AskUserQuestion tool_use, normalized from the raw
 * `{question, id?, header?, options, multiSelect?}` shape (reverse-engineered
 * from Claudian's OA inline-question widget's own parseQuestions()). */
interface ParsedQuestion {
  /** Result object key for this question: `id` if the tool call provided one, else the question text itself - same fallback OA's own submit path uses. */
  key: string;
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; value: string }[];
}

type PendingInteractive =
  | {
      kind: 'question';
      tabId: string;
      questions: ParsedQuestion[];
      /** question index -> set of selected option *values* (or a single freeform string for isOther-style answers). */
      selections: Map<number, Set<string>>;
      resolve: (value: Record<string, string | string[]> | null) => void;
    }
  | {
      kind: 'approval';
      tabId: string;
      title: string;
      resolve: (value: 'accept' | 'acceptForSession' | 'decline' | 'cancel') => void;
    };

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
  // ---- reverse questions (AskUserQuestion) / approval prompts ----
  askUserQuestionHeader: {
    zh: 'Claudian 有问题想问你：',
    en: 'Claudian is asking you something:',
  },
  askUserQuestionUsageSingle: {
    zh: '回复 /answer 序号（如 /answer 2，多选用逗号分隔如 /answer 1,3）或 /answer 你的文字回答；/answer cancel 取消。',
    en: 'Reply /answer <number> (e.g. /answer 2; comma-separate for multi-select like /answer 1,3), or /answer <free text>. /answer cancel to cancel.',
  },
  askUserQuestionUsageMulti: {
    zh: '回复 /answer 题号 选项（如 /answer 1 2，多选逗号分隔），每题回复一次，答完自动提交；/answer cancel 取消。',
    en: 'Reply /answer <question#> <option#> (e.g. /answer 1 2; comma-separate for multi-select) once per question - submits automatically once all are answered. /answer cancel to cancel.',
  },
  answerUsage: { zh: '用法: /answer <序号|文字>，或 /answer cancel', en: 'Usage: /answer <number|text>, or /answer cancel' },
  answerUsageMulti: {
    zh: '有多道题，请用 /answer 题号 选项 的格式，如 /answer 1 2。',
    en: 'Multiple questions pending - use /answer <question#> <option#>, e.g. /answer 1 2.',
  },
  noPendingQuestion: { zh: '当前没有待回答的问题。', en: 'No question is currently pending.' },
  questionCancelled: { zh: '已取消该问题。', en: 'Question cancelled.' },
  questionAnswered: { zh: '已提交回答，Claudian 将继续处理。', en: 'Answer submitted; Claudian will continue.' },
  questionPartial: {
    zh: (done: number, total: number) => `已记录 (${done}/${total})，请继续回答剩余问题。`,
    en: (done: number, total: number) => `Recorded (${done}/${total}) - keep answering the remaining questions.`,
  },
  approvalHeader: {
    zh: (title: string, desc: string) => `Claudian 请求权限:\n${title}\n${desc}\n\n回复 /approve accept（仅本次）、/approve always（本次会话内始终允许）、/approve deny（拒绝）或 /approve cancel（取消本轮）。`,
    en: (title: string, desc: string) => `Claudian is requesting approval:\n${title}\n${desc}\n\nReply /approve accept (just once), /approve always (allow for this session), /approve deny, or /approve cancel.`,
  },
  approveUsage: { zh: '用法: /approve accept|always|deny|cancel', en: 'Usage: /approve accept|always|deny|cancel' },
  noPendingApproval: { zh: '当前没有待处理的权限请求。', en: 'No approval request is currently pending.' },
  approvalResolved: {
    zh: (d: string) => `已提交: ${d}`,
    en: (d: string) => `Submitted: ${d}`,
  },
  progressiveOn: {
    zh: '渐进式回复已开启（全局生效，所有对话）：Claudian 每说完一段就会单独推送一条，不再等整轮结束才一次性回复。',
    en: 'Progressive replies enabled (global, applies to every conversation): each finished chunk is pushed as its own message instead of waiting for the whole turn.',
  },
  progressiveOff: { zh: '渐进式回复已关闭，恢复为整轮结束后一次性回复。', en: 'Progressive replies disabled; back to one reply per turn.' },
  progressiveUsage: { zh: '用法: /progressive on 或 /progressive off', en: 'Usage: /progressive on or /progressive off' },
  statusProgressiveLabel: { zh: '渐进式回复: ', en: 'Progressive replies: ' },
  switchedAwayTag: {
    zh: (title: string, prompt: string, reply: string) => `[来自其他对话] ${title}\nprompt：${prompt}\n\n${reply}`,
    en: (title: string, prompt: string, reply: string) => `[From another conversation] ${title}\nprompt: ${prompt}\n\n${reply}`,
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
    '/answer — 回答 Claudian 反向提出的问题（AskUserQuestion），收到推送后按提示格式回复',
    '/approve accept|always|deny|cancel — 回应 Claudian 的权限请求，收到推送后使用',
    '/progressive on 或 /progressive off — 开关渐进式回复（全局）：开启后每说完一段就单独推送，不等整轮结束',
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
    '/answer — answer a question Claudian asked back (AskUserQuestion); reply in the format shown in the push notification',
    '/approve accept|always|deny|cancel — respond to a Claudian approval request; use after a push notification',
    '/progressive on or /progressive off — toggle progressive replies (global): when on, each finished chunk is pushed separately instead of waiting for the whole turn',
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
  progressiveReply: false,
};

const LISTEN_POLL_INTERVAL_MS = 3000;
/** How often an in-flight bridge-driven send is checked for newly-settled text chunks while /progressive is on. */
const PROGRESSIVE_POLL_INTERVAL_MS = 1200;

export default class WeChatBridgePlugin extends Plugin {
  private server: http.Server | null = null;
  private data: BridgeData = { ...DEFAULT_DATA };
  /** Pushes queued by the /listen poller, drained by the relay's /pending polling. */
  private pendingPushes: string[] = [];
  /** tab.id's currently being driven by this plugin's own sendChatMessage(), so
   * the /listen poller does not mistake a WeChat-originated turn for a desktop
   * one. A set, not a single flag, because sends to different tabs can now be
   * in flight concurrently (see sendQueues doc comment). */
  private sendingViaBridgeTabIds: Set<string> = new Set();
  private relayManager: RelayManager | null = null;
  private pluginDir: string | null = null;
  /**
   * Per-tab send queues, keyed by tab.id. A chat message to conversation A no
   * longer blocks a /switch, /new, /answer, /approve, or a message sent to a
   * *different* conversation - only two sends to the *same* tab still
   * serialize against each other (so they don't corrupt one turn). Quick
   * commands (everything except the final "send this as a chat message"
   * fallback) never touch this at all; they run immediately. This replaces
   * the old single global `busy` chain, which used to make every command -
   * even /switch - wait for whatever chat turn was already in flight, which
   * is exactly the deadlock that made /answer and /approve impossible: they
   * exist to unblock an in-flight turn, but couldn't run until it unblocked.
   */
  private sendQueues: Map<string, Promise<unknown>> = new Map();
  /**
   * A single outstanding AskUserQuestion or approval request, surfaced via
   * pendingPushes and resolved by /answer or /approve. Not persisted across
   * reloads (a reload mid-question loses it; Claudian's own turn would then
   * just hang - rare enough, and safer than trying to serialize a live
   * Promise resolver to disk).
   */
  private pendingInteractive: PendingInteractive | null = null;
  /**
   * Per-tab progress cursor for /progressive mode, live only for the duration
   * of one queued send (created and torn down inside sendChatMessage). Tracks
   * how much of the in-flight turn's messages/blocks have already been
   * pushed to WeChat, so flushProgressive() only ever pushes each settled
   * chunk once.
   */
  private progressiveCursors: Map<string, { pushedMessageCount: number; pushedBlocksInCurrent: number }> = new Map();

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
        res.end(JSON.stringify({ ok: true, pushes, listening: this.data.listening, progressive: this.data.progressiveReply }));
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
        // No global serialization here on purpose: a long-running chat turn
        // for one conversation must not block /switch, /new, /answer,
        // /approve, or a message aimed at a different conversation from being
        // handled right away (see sendQueues doc comment). Only sends to the
        // *same* tab still serialize against each other, inside
        // sendChatMessageQueued.
        this.handleIncoming(body)
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

    // /answer and /approve must never wait behind an in-flight chat turn -
    // they exist specifically to unblock one (Claudian is paused mid-turn
    // waiting on exactly this). Handled first, synchronously, against
    // in-memory state only.
    if (/^\/answer\b/i.test(text)) {
      return await this.handleAnswerCommand(text, lang);
    }
    if (/^\/approve\b/i.test(text)) {
      return await this.handleApproveCommand(text, lang);
    }

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

    const progressiveMatch = text.match(/^\/progressive\s+(on|off)\b/i);
    if (progressiveMatch) {
      this.data.progressiveReply = progressiveMatch[1].toLowerCase() === 'on';
      await this.saveData(this.data);
      return pick(this.data.progressiveReply ? STRINGS.progressiveOn : STRINGS.progressiveOff, lang);
    }
    if (/^\/progressive\b/i.test(text)) {
      return pick(STRINGS.progressiveUsage, lang);
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
    return await this.sendChatMessageQueued(text, lang, image);
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
    const progressiveWord = this.data.progressiveReply
      ? pick(STRINGS.statusListeningOn, lang)
      : pick(STRINGS.statusListeningOff, lang);
    return `${base}${providerLine}\n${pick(STRINGS.statusListeningLabel, lang)}${listeningWord}\n${pick(STRINGS.statusProgressiveLabel, lang)}${progressiveWord}`;
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
    if (!this.data.listening) return;
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
    // A bridge-driven send to this exact tab is in flight; its own reply path
    // (sendChatMessage/sendChatMessageQueued) reports it, not this poller.
    if (this.sendingViaBridgeTabIds.has(tab.id)) return;

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

  /**
   * Entry point used by handleIncoming(). Resolves the target tab *before*
   * queuing, then queues only the actual send against that specific tab's
   * own queue - so a slow turn on tab A never delays a message aimed at tab
   * B (a different conversation), and a /switch or /new that runs in between
   * (outside this queue entirely - see handleIncoming) is never blocked by
   * either.
   */
  private async sendChatMessageQueued(text: string, lang: Lang, image?: IncomingImage): Promise<string> {
    const tab = await this.getOrCreateWeChatTab();
    // Snapshot which conversation this send targets and which one is
    // "current" *before* queuing, not after: if the user fires off /switch or
    // /new while this send is still waiting in line, this call must still
    // finish delivering the turn it was actually asked to send, to the
    // conversation it was actually sent to - only the *labeling* of the
    // reply (see sendChatMessage) depends on whether that's still the
    // "current" one by the time it completes.
    const conversationIdAtQueueTime = this.data.conversationId;
    const previous = this.sendQueues.get(tab.id) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.sendChatMessage(tab, text, lang, image, conversationIdAtQueueTime));
    // Store a settle-agnostic tail so the *next* queued send for this tab
    // waits for this one regardless of whether it threw, without this
    // rejection also propagating to whoever's awaiting `run` for the reply.
    this.sendQueues.set(tab.id, run.catch(() => {}));
    return run;
  }

  private async sendChatMessage(
    tab: ClaudianTab,
    text: string,
    lang: Lang,
    image: IncomingImage | undefined,
    conversationIdAtQueueTime: string | null,
  ): Promise<string> {
    if (!tab.controllers.inputController) {
      throw new Error(pick(STRINGS.tabNotReady, lang));
    }

    this.sendingViaBridgeTabIds.add(tab.id);
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

      const progressive = this.data.progressiveReply;
      let progressiveTimer: number | null = null;
      let pushedAnything = false;
      if (progressive) {
        this.progressiveCursors.set(tab.id, { pushedMessageCount: 0, pushedBlocksInCurrent: 0 });
        progressiveTimer = window.setInterval(() => this.flushProgressive(tab, beforeCount, false), PROGRESSIVE_POLL_INTERVAL_MS);
      }
      try {
        await tab.controllers.inputController.sendMessage({ content: text, images });
      } finally {
        if (progressiveTimer !== null) window.clearInterval(progressiveTimer);
        if (progressive) {
          // Final flush treats the very last block as settled too (it can
          // no longer still be growing - the turn is over), so nothing
          // produced right at the tail end between the last poll tick and
          // completion gets missed.
          this.flushProgressive(tab, beforeCount, true);
          const cursor = this.progressiveCursors.get(tab.id);
          pushedAnything = !!cursor && (cursor.pushedMessageCount > 0 || cursor.pushedBlocksInCurrent > 0);
          this.progressiveCursors.delete(tab.id);
        }
      }

      // Only rebind data.conversationId / lastSeenMessageCount if nothing
      // else has claimed the "current conversation" slot while this send was
      // running (i.e. no /switch or /new happened meanwhile). If it *has*
      // changed, leave the current binding alone - some other conversation is
      // now live and this reply must not silently reattach to it.
      const stillCurrent = this.data.conversationId === conversationIdAtQueueTime;
      if (stillCurrent) {
        if (tab.conversationId && tab.conversationId !== this.data.conversationId) {
          this.data.conversationId = tab.conversationId;
        }
        // Keep the /listen poller's baseline in sync so it doesn't re-report
        // the turn this call itself just produced.
        this.data.lastSeenMessageCount = tab.state.messages.length;
        await this.saveData(this.data);
      }

      const newMessages = tab.state.messages.slice(beforeCount);
      const reply = this.extractDispatchText(newMessages, lang);
      const ctxLine = await this.contextWindowLine(tab.conversationId, lang);
      const body = ctxLine ? `${reply}\n\n${ctxLine}` : reply;

      if (progressive && pushedAnything) {
        // Every chunk already went out individually via flushProgressive() as
        // the turn ran (each one tagged with the conversation title if it
        // wasn't the current one at push time) - repeating the whole thing
        // here would duplicate everything the user just saw arrive piece by
        // piece. Only the context-window line rides along in the HTTP reply,
        // since that's computed once at the end and was never part of a chunk.
        return ctxLine ?? '';
      }

      if (stillCurrent) return body;

      // The user switched to a different conversation (or started a new one)
      // while this turn was still running. The reply is still delivered -
      // dropping it would silently lose a turn that Claudian actually ran -
      // but tagged with which conversation and prompt it belongs to, since
      // by the time it arrives it's no longer obvious from context.
      const metas = await this.readAllConversationMeta();
      const title = metas.find((m) => m.id === tab.conversationId)?.title ?? tab.conversationId ?? '?';
      return pick(STRINGS.switchedAwayTag, lang)(title, text, body);
    } finally {
      this.sendingViaBridgeTabIds.delete(tab.id);
    }
  }

  /**
   * Pushes any newly-settled narrative-text chunks from `tab`'s messages
   * (from `beforeCount` onward, i.e. just this turn) to WeChat, advancing
   * this tab's progressiveCursors entry so nothing is ever pushed twice.
   *
   * A block is "settled" - safe to push - once something else is known to
   * come after it (a later block in the same message, or the message itself
   * is no longer the last one): Claudian streams text into the *last* block
   * of the *last* message in place, so that one specific block is the only
   * one that can still still be actively growing. `final=true` (passed once,
   * right after the turn's own sendMessage() promise resolves) means the
   * whole turn is over and even that last block can no longer change, so it
   * gets flushed too.
   *
   * Only `text` content blocks are pushed - same filter extractDispatchText()
   * uses for the normal (non-progressive) reply - tool_use/thinking/subagent
   * blocks stay silent. Each pushed chunk is tagged with the conversation
   * title if that conversation is no longer the one currently bound (the
   * user switched away mid-turn), same intent as switchedAwayTag but applied
   * per-chunk since chunks go out individually rather than as one reply.
   */
  private flushProgressive(tab: ClaudianTab, beforeCount: number, final: boolean): boolean {
    const cursor = this.progressiveCursors.get(tab.id);
    if (!cursor) return false;
    const messages = tab.state.messages.slice(beforeCount);
    let pushedSomething = false;

    // Best-effort tag: no time to await a fresh conversation-list read from a
    // setInterval tick, so this reuses whatever readAllConversationMeta()
    // last cached (refreshed at least once per /list, /switch, or turn-end),
    // falling back to the raw id if nothing's cached yet.
    const tag = tab.conversationId && tab.conversationId !== this.data.conversationId
      ? `[${this.metaCache?.metas.find((m) => m.id === tab.conversationId)?.title ?? tab.conversationId}] `
      : '';

    for (let mi = cursor.pushedMessageCount; mi < messages.length; mi++) {
      const msg = messages[mi];
      const isLastMessage = mi === messages.length - 1;
      if (msg.role !== 'assistant') {
        cursor.pushedMessageCount = mi + 1;
        cursor.pushedBlocksInCurrent = 0;
        continue;
      }
      const blocks: ContentBlock[] = msg.contentBlocks && msg.contentBlocks.length > 0
        ? msg.contentBlocks
        : (msg.content.trim() ? [{ type: 'text', content: msg.content }] : []);
      const settledCount = (isLastMessage && !final) ? Math.max(0, blocks.length - 1) : blocks.length;

      for (let bi = cursor.pushedBlocksInCurrent; bi < settledCount; bi++) {
        const block = blocks[bi];
        if (block.type === 'text') {
          const trimmed = block.content.trim();
          if (trimmed) {
            this.pendingPushes.push(`${tag}${trimmed}`);
            pushedSomething = true;
          }
        }
        cursor.pushedBlocksInCurrent = bi + 1;
      }

      if (isLastMessage && !final) break; // still the active message; may grow more blocks next tick
      cursor.pushedMessageCount = mi + 1;
      cursor.pushedBlocksInCurrent = 0;
    }

    return pushedSomething;
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
      if (existing) {
        this.installInteractiveHooks(existing);
        return existing;
      }
      // Tab was closed or conversation was never opened in a tab yet; (re)open it.
      await this.ensureTabCapacity(claudian, tabManager);
      const tab = await tabManager.createTab(this.data.conversationId);
      if (!tab) throw new Error(pick(STRINGS.tabLimitReached, this.getLangSafe()));
      this.installInteractiveHooks(tab);
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
    this.installInteractiveHooks(tab);
    return tab;
  }

  /**
   * Replaces this tab's inputController.handleAskUserQuestion /
   * handleApprovalRequest with headless versions that push a WeChat
   * notification and resolve from /answer or /approve, instead of rendering
   * Claudian's inline DOM widgets (OA / the approval-inline widget) that
   * nobody is looking at for a bridge-driven tab. Idempotent per
   * inputController instance (guarded by a marker property) since
   * getOrCreateWeChatTab() runs this on every call.
   *
   * Trade-off: once installed, this tab's native desktop UI no longer shows
   * its own inline question/approval widgets either - acceptable since this
   * tab exists specifically to be driven remotely from WeChat.
   */
  private installInteractiveHooks(tab: ClaudianTab): void {
    const ic = tab.controllers.inputController as (ClaudianTab['controllers']['inputController'] & { __wechatBridgePatched?: boolean }) | null;
    if (!ic || ic.__wechatBridgePatched) return;
    ic.__wechatBridgePatched = true;
    ic.handleAskUserQuestion = async (input: any) => this.handleAskUserQuestionHeadless(tab, input);
    ic.handleApprovalRequest = async (kind: string, details: any, title: string, opts: any) =>
      this.handleApprovalRequestHeadless(tab, kind, details, title, opts);
  }

  /**
   * Headless stand-in for Claudian's inline AskUserQuestion widget (OA class
   * in main.js). Normalizes the raw tool_use `questions` array the same way
   * OA.parseQuestions() does, pushes a WeChat notification, and resolves once
   * /answer has collected an answer for every question - matching the result
   * shape OA's own submit path builds: `{[question.id ?? question.question]: value | value[]}`.
   */
  private async handleAskUserQuestionHeadless(tab: ClaudianTab, input: any): Promise<Record<string, string | string[]> | null> {
    const rawQuestions = Array.isArray(input?.questions) ? input.questions : [];
    const questions: ParsedQuestion[] = rawQuestions
      .filter((q: any) => q && typeof q === 'object' && typeof q.question === 'string' && Array.isArray(q.options) && q.options.length > 0)
      .map((q: any, i: number) => ({
        key: typeof q.id === 'string' ? q.id : q.question,
        question: q.question,
        header: typeof q.header === 'string' ? q.header.slice(0, 12) : `Q${i + 1}`,
        multiSelect: q.multiSelect === true,
        options: (q.options as any[]).map((o) => {
          if (o && typeof o === 'object') {
            const label = typeof o.label === 'string' ? o.label : typeof o.value === 'string' ? o.value : typeof o.text === 'string' ? o.text : typeof o.name === 'string' ? o.name : 'Option';
            const value = typeof o.value === 'string' ? o.value : typeof o.id === 'string' ? o.id : label;
            return { label: String(label), value: String(value) };
          }
          return { label: String(o), value: String(o) };
        }),
      }));

    if (questions.length === 0) return null;

    const lang = this.getLangSafe();
    const lines: string[] = [pick(STRINGS.askUserQuestionHeader, lang)];
    questions.forEach((q, qi) => {
      lines.push(`\n${questions.length > 1 ? `[${qi + 1}] ` : ''}${q.question}`);
      q.options.forEach((o, oi) => lines.push(`  ${oi + 1}. ${o.label}`));
    });
    lines.push('\n' + pick(questions.length > 1 ? STRINGS.askUserQuestionUsageMulti : STRINGS.askUserQuestionUsageSingle, lang));

    return new Promise((resolve) => {
      this.pendingInteractive = { kind: 'question', tabId: tab.id, questions, selections: new Map(), resolve };
      this.pendingPushes.push(lines.join('\n'));
    });
  }

  /** Headless stand-in for Claudian's inline command/file/permission approval widget. */
  private async handleApprovalRequestHeadless(
    tab: ClaudianTab,
    kind: string,
    details: any,
    title: string,
    _opts: any,
  ): Promise<'accept' | 'acceptForSession' | 'decline' | 'cancel'> {
    const lang = this.getLangSafe();
    const desc = kind === 'command_execution' && typeof details?.command === 'string'
      ? details.command
      : String(details?.reason ?? title ?? kind);
    return new Promise((resolve) => {
      this.pendingInteractive = { kind: 'approval', tabId: tab.id, title, resolve };
      this.pendingPushes.push(pick(STRINGS.approvalHeader, lang)(title, desc));
    });
  }

  /** Handles `/answer ...`, resolving whatever handleAskUserQuestionHeadless() is currently waiting on. */
  private async handleAnswerCommand(text: string, lang: Lang): Promise<string> {
    const pending = this.pendingInteractive;
    if (!pending || pending.kind !== 'question') return pick(STRINGS.noPendingQuestion, lang);

    const rest = text.replace(/^\/answer\s*/i, '').trim();
    if (/^cancel$/i.test(rest)) {
      pending.resolve(null);
      this.pendingInteractive = null;
      return pick(STRINGS.questionCancelled, lang);
    }
    if (!rest) return pick(STRINGS.answerUsage, lang);

    let qIndex: number;
    let selectionText: string;
    if (pending.questions.length > 1) {
      const m = rest.match(/^(\d+)\s+(.+)$/);
      if (!m) return pick(STRINGS.answerUsageMulti, lang);
      qIndex = Number(m[1]) - 1;
      selectionText = m[2];
    } else {
      qIndex = 0;
      selectionText = rest;
    }
    const q = pending.questions[qIndex];
    if (!q) return pick(STRINGS.outOfRange, lang)(pending.questions.length);

    const set = pending.selections.get(qIndex) ?? new Set<string>();
    const parts = selectionText.split(',').map((s) => s.trim()).filter(Boolean);
    const allNumeric = parts.length > 0 && parts.every((p) => /^\d+$/.test(p));
    if (allNumeric) {
      if (!q.multiSelect) set.clear();
      for (const p of parts) {
        const opt = q.options[Number(p) - 1];
        if (opt) set.add(opt.value);
      }
    } else {
      // Freeform text answer (e.g. for an "other" option Claude offered, or
      // just typing the option's label instead of its number).
      const matched = q.options.find((o) => o.label.toLowerCase() === selectionText.trim().toLowerCase());
      set.clear();
      set.add(matched ? matched.value : selectionText.trim());
    }
    pending.selections.set(qIndex, set);

    if (pending.selections.size >= pending.questions.length) {
      const result: Record<string, string | string[]> = {};
      pending.questions.forEach((qq, i) => {
        const sel = pending.selections.get(i);
        if (!sel || sel.size === 0) return;
        result[qq.key] = qq.multiSelect ? Array.from(sel) : Array.from(sel)[0];
      });
      pending.resolve(result);
      this.pendingInteractive = null;
      return pick(STRINGS.questionAnswered, lang);
    }
    return pick(STRINGS.questionPartial, lang)(pending.selections.size, pending.questions.length);
  }

  /** Handles `/approve accept|always|deny|cancel`, resolving handleApprovalRequestHeadless(). */
  private async handleApproveCommand(text: string, lang: Lang): Promise<string> {
    const pending = this.pendingInteractive;
    if (!pending || pending.kind !== 'approval') return pick(STRINGS.noPendingApproval, lang);
    const m = text.match(/^\/approve\s+(accept|always|deny|cancel)\b/i);
    if (!m) return pick(STRINGS.approveUsage, lang);
    const word = m[1].toLowerCase();
    const decision = word === 'accept' ? 'accept' : word === 'always' ? 'acceptForSession' : word === 'deny' ? 'decline' : 'cancel';
    pending.resolve(decision as 'accept' | 'acceptForSession' | 'decline' | 'cancel');
    this.pendingInteractive = null;
    return pick(STRINGS.approvalResolved, lang)(decision);
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
