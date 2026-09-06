import { Plugin, FileSystemAdapter, Notice } from 'obsidian';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import { RelayManager } from './relayManager';
import { WeChatBridgeSettingTab } from './settingsTab';
import { EMBEDDED_RELAY_PY, EMBEDDED_STRINGS_JSON } from './embeddedAssets';

/**
 * WeChat Bridge
 *
 * Local-only HTTP server that drives the installed Claudian plugin
 * (id: "realclaudian") the same way its own UI does:
 *   - chat text                -> InputController.sendMessage({ content }) on a dedicated tab
 *   - /model X /effort X /permission X -> plugin.mutateSettings() + UI refresh
 *   - /ls                      -> list known conversations (from .claudian/sessions/*.meta.json)
 *   - /goto N                  -> point the bridge's tab at conversation #N from the last /ls
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

/**
 * A file queued for outbound delivery to WeChat, drained by relay.py through
 * /pending the same way pendingPushes (text) already is. relay.py and this
 * plugin run on the same machine (the plugin spawns relay.py itself), so
 * this carries a plain local filesystem path rather than base64 bytes - no
 * reason to round-trip a potentially large file through JSON over loopback
 * when relay.py can just read it straight off disk (wechat_clawbot's own
 * upload_*_to_weixin helpers already take a file path, not a buffer).
 */
interface PendingFileItem {
  absolutePath: string;
  fileName: string;
  /** Picks which wechat_clawbot upload/send pair relay.py uses. */
  category: 'image' | 'video' | 'file';
}

/**
 * A /schedule entry: a plain text reminder pushed straight to WeChat via
 * pendingPushes (same drain path as /listen mirrors and progressive-reply
 * chunks) when it comes due - it never touches Claudian/sendChatMessageQueued,
 * it's a local alarm clock, not an AI turn. `nextFireAt` is always the next
 * (or only, for one-shot) fire time in epoch ms; `repeat` describes how to
 * recompute it after firing, or is null for a one-shot entry that gets
 * removed from `scheduledSends` once it fires.
 */
interface ScheduledSend {
  id: string;
  text: string;
  nextFireAt: number;
  repeat: null | { type: 'daily'; hour: number; minute: number };
}

/**
 * Backs pendingPushes/pendingFiles. The naive version of this (a plain array,
 * cleared the instant /pending's GET handler reads it) is at-most-once
 * delivery: if the HTTP response never actually reaches relay.py - a
 * localhost hiccup, or relay.py's own client timing out because Obsidian's
 * event loop was busy with something else for a few seconds - the array is
 * already empty server-side by then, so that batch of text is gone for good,
 * with nothing logged on either side (relay.py's poll loop swallows that
 * exception silently and just retries next tick). Confirmed as the cause of
 * a real "最后一段/几段漏发" report: relay.log showed no error at all for the
 * affected turn, which only makes sense if the loss happened on a request
 * relay.py never even logged as failed - a response that departed the
 * request but never reached it.
 *
 * Fix: don't clear on read. Every item gets a monotonically increasing id
 * when queued; a GET only removes items once the client explicitly says
 * "I successfully processed up through id N" on its *next* call (via the
 * `ack` query param - see /pending). If a response is lost in transit, the
 * client never learns those ids exist, never acks them, and they simply come
 * back (still unacked) on the next poll - a duplicate send in the rare case
 * where the response secretly *did* arrive but the ack for it later got
 * lost, but never a silent loss.
 */
class AckQueue<T> {
  private items: T[] = [];
  private baseSeq = 0;

  /**
   * Fired after every push()/ack() with the current contents, so the plugin
   * can mirror them into BridgeData and persist. Without this, an unacked
   * item only ever lived in this in-memory array - surviving the relay.py
   * transit problem this class was built to fix, but still lost outright if
   * the *plugin itself* reloads/crashes before relay.py ever fetched it (a
   * real, non-theoretical case: every fix this bridge ships requires exactly
   * that reload). Persisting closes the same class of gap one layer up.
   */
  constructor(private onChange?: (items: T[]) => void) {}

  push(...newItems: T[]): void {
    this.items.push(...newItems);
    this.onChange?.(this.items);
  }

  get length(): number {
    return this.items.length;
  }

  /** Current contents tagged with the ids a client should echo back via ack(). Does not remove anything. */
  snapshot(): { id: number; item: T }[] {
    return this.items.map((item, i) => ({ id: this.baseSeq + i, item }));
  }

  /** Removes every item whose id is <= ackId. Ignores stale/out-of-range acks instead of throwing. */
  ack(ackId: number): void {
    if (!Number.isFinite(ackId) || ackId < this.baseSeq) return;
    const removeCount = Math.min(this.items.length, ackId - this.baseSeq + 1);
    if (removeCount <= 0) return;
    this.items.splice(0, removeCount);
    this.baseSeq += removeCount;
    this.onChange?.(this.items);
  }
}

interface BridgeData {
  conversationId: string | null;
  /** conversation ids in the order shown by the last /ls, for /goto N to index into. */
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
   * Which conversation lastSeenMessageCount was counted against. Autonomous-
   * turn mirroring (see checkForDesktopActivity) tracks the *currently
   * WeChat-bound* conversation (data.conversationId) regardless of /listen,
   * so unlike listeningConversationId this is not an opt-in scope - it's just
   * bookkeeping to detect "the bound conversation changed under us" (via
   * /switch, /new, or a fresh tab picking up an id) and resync instead of
   * either replaying the new conversation's entire history or comparing
   * against a stale count from a different conversation.
   */
  lastSeenConversationId: string | null;
  /**
   * Mirror of pendingPushes'/pendingFiles' current (unacked) contents - see
   * AckQueue's onChange. Rehydrated into the live AckQueues in onload() so a
   * plugin reload/crash with content still queued but not yet fetched by
   * relay.py doesn't lose it; onunload's flush (see that comment) makes sure
   * whatever's here on disk is current at the moment of a reload.
   */
  pendingPushQueue: string[];
  pendingFileQueue: PendingFileItem[];
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
  /** /schedule entries, checked once per LISTEN_POLL_INTERVAL_MS tick (see checkScheduledSends). */
  scheduledSends: ScheduledSend[];
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
  /**
   * The raw tool calls behind this message's `tool_use` content blocks -
   * contentBlocks only carries a bare `toolId` (see ContentBlock above);
   * this is where the actual `name`/`input` live, reverse-engineered from
   * Claudian's message-building code (LBe() for the Claude provider,
   * equivalents for Codex/pi). `input` is provider- and tool-specific -
   * for Claude Code's own Write/Edit/Read/NotebookEdit tools it's
   * `{file_path: string, ...}`; used by extractReferencedFiles() to find
   * files a turn actually touched, without having to guess from prose.
   */
  toolCalls?: { id: string; name: string; input?: Record<string, unknown> }[];
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
      /** Interrupts the in-flight turn (same call the desktop UI's own "Stop"
       * button and Escape key make - reverse-engineered as InputController's
       * `cancelStreaming()`: aborts the provider's abortController, marks the
       * session interrupted, and hides the thinking indicator). The turn's
       * own `sendMessage()` promise still resolves normally afterward with
       * whatever text had already streamed in, same as clicking Stop does -
       * this bridge doesn't need to synthesize a reply for /esc itself. */
      cancelStreaming?(): void;
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
  getTab?(tabId: string): ClaudianTab | null;
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
  /**
   * Added in Claudian's dual-pane release (2.1.0+): `getAllViews()` can now
   * return more than one view (one per pane), each with its own independent
   * tab manager/tab set. Before dual-pane, `getOrCreateWeChatTab` picking
   * `getAllViews()[0]` and searching only its tab manager was safe because
   * there was only ever one view. Now, if the bridge's bound conversation's
   * tab happens to live in a *different* pane's view, that search would miss
   * it and spawn a duplicate tab instead of reusing the real one. Claudian
   * itself ships this helper to search every view's tab manager in one call
   * - prefer it over reimplementing the same loop, and fall back to the old
   * single-view behavior only if an older Claudian build doesn't have it.
   */
  findConversationAcrossViews?(conversationId: string): { view: ClaudianView; tabId: string } | null;
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

/**
 * Claudian's inputController object, as patched by installInteractiveHooks.
 * `__wechatBridgeOwner` records which plugin instance last patched it (so a
 * post-reload instance knows to re-patch rather than trust a stale one's
 * handlers); `__wechatPendingInteractive` records a still-unresolved
 * question/approval so a fresh instance can adopt it after reload instead of
 * losing all contact with the resolve closure Claudian's own turn is still
 * awaiting.
 */
type WeChatPatchedInputController = NonNullable<ClaudianTab['controllers']['inputController']> & {
  __wechatBridgeOwner?: unknown;
  __wechatPendingInteractive?: PendingInteractive;
  /**
   * Claudian's genuinely-native handleAskUserQuestion/handleApprovalRequest,
   * captured once (ever, across all reloads) the first time
   * installInteractiveHooks sees this inputController - i.e. before anyone
   * has patched it. Kept around so the headless path can call the native
   * handler *alongside* the WeChat push instead of *instead of* it, so a
   * user sitting at the desktop still sees Claudian's own inline widget and
   * isn't left staring at nothing just because this tab also happens to be
   * WeChat-bound.
   */
  __wechatOriginalHandleAskUserQuestion?: (input: any) => Promise<Record<string, string | string[]> | null>;
  __wechatOriginalHandleApprovalRequest?: (
    kind: string,
    details: any,
    title: string,
    opts: any,
  ) => Promise<'accept' | 'acceptForSession' | 'decline' | 'cancel'>;
};

type PendingInteractive =
  | {
      kind: 'question';
      tabId: string;
      questions: ParsedQuestion[];
      /** question index -> set of selected option *values* (or a single freeform string for isOther-style answers). */
      selections: Map<number, Set<string>>;
      resolve: (value: Record<string, string | string[]> | null) => void;
      /** The exact text already pushed to WeChat for this question - see the
       * `__wechatPendingInteractive` adoption path in installInteractiveHooks
       * for why this needs to be re-sendable after a plugin reload. */
      promptText: string;
      /** The inputController this request's `resolve` closure is bound to
       * (survives a wechat-bridge plugin reload, since Claudian itself isn't
       * reloaded) - stashed here so the resolving code can clear the
       * matching `__wechatPendingInteractive` marker off of it once this
       * request is actually settled. */
      sourceIc: WeChatPatchedInputController;
    }
  | {
      kind: 'approval';
      tabId: string;
      title: string;
      resolve: (value: 'accept' | 'acceptForSession' | 'decline' | 'cancel') => void;
      promptText: string;
      sourceIc: WeChatPatchedInputController;
    };

interface ConversationMeta {
  id: string;
  title?: string;
  // Claudian 2.0.x writes `lastActivityAt` (and `createdAt`), not
  // `updatedAt` - there is no `updatedAt` field in real meta.json files.
  // Kept both here so a future Claudian rename doesn't silently break
  // sorting again: sortKey() below tries each in order and falls back to 0
  // (never throws on an unfamiliar shape).
  lastActivityAt?: number;
  createdAt?: number;
  providerId?: string;
  usage?: { contextTokens?: number; contextWindow?: number };
}

function conversationSortKey(m: ConversationMeta): number {
  return m.lastActivityAt ?? m.createdAt ?? 0;
}

// ---- i18n ----
// Language is decided per-request from Claudian's own `settings.locale`
// (e.g. "zh-CN", "en"), not from any setting of this plugin's own.
type Lang = 'zh' | 'en';

// All bilingual user-facing text lives in strings.json (next to main.js in
// the plugin folder), not here - see loadStrings() below for why, and the
// file itself for the {0}/{1}/... placeholder convention `t()` substitutes.
interface StringsData {
  help: { zh: string[]; en: string[] };
  [key: string]: { zh: string; en: string } | { zh: string[]; en: string[] };
}

const STRINGS_FILE_NAME = 'strings.json';

const DEFAULT_DATA: BridgeData = {
  conversationId: null,
  lastListedIds: [],
  listening: false,
  listeningConversationId: null,
  lastSeenMessageCount: 0,
  lastSeenConversationId: null,
  pendingPushQueue: [],
  pendingFileQueue: [],
  providerId: null,
  progressiveReply: true,
  scheduledSends: [],
};

const LISTEN_POLL_INTERVAL_MS = 3000;
/** /ls defaults to the most recent conversations only; /ls all shows everything. */
const LIST_DEFAULT_LIMIT = 10;
/** How often an in-flight bridge-driven send is checked for newly-settled text chunks while /progressive is on. */
const PROGRESSIVE_POLL_INTERVAL_MS = 1200;
/** Same cap style as relay.py's own _IMAGE_MAX_BYTES for inbound images - just checked here instead, before a file is even queued, so a huge file fails fast with a clear reason instead of relay.py silently choking on the CDN upload later. */
const FILE_SEND_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm']);
/** Wikilink / embed syntax Claudian's own reply renderer turns into clickable
 * "jump to this file" links (reverse-engineered: `jue()`/`Bue` in main.js) -
 * reused here to find the same files, just surfaced as a numbered /files
 * list instead of a click target. */
const WIKILINK_RE = /!?\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
/** Common parameter names across providers' file-touching tools (Claude
 * Code's Write/Edit/Read/NotebookEdit all use file_path; other providers
 * vary) - checked generically rather than allow-listing exact tool names per
 * provider, since a false-positive candidate just gets filtered out later by
 * queueFileForSend's own existence check anyway. */
const TOOL_INPUT_PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'notebookPath'];

export default class WeChatBridgePlugin extends Plugin {
  private server: http.Server | null = null;
  private data: BridgeData = { ...DEFAULT_DATA };
  /** Pushes queued by the /listen poller, drained (ack-based, see AckQueue) by the relay's /pending polling. */
  private pendingPushes = new AckQueue<string>((items) => {
    this.data.pendingPushQueue = items;
    void this.saveData(this.data);
  });
  /** tab.id's currently being driven by this plugin's own sendChatMessage(), so
   * the /listen poller does not mistake a WeChat-originated turn for a desktop
   * one. A set, not a single flag, because sends to different tabs can now be
   * in flight concurrently (see sendQueues doc comment). */
  private sendingViaBridgeTabIds: Set<string> = new Set();
  /**
   * Bare (caption-less) inbound images, held indefinitely waiting for a
   * follow-up text message to combine with as their shared caption (or an
   * explicit /skip to send them alone) - see handleIncoming. Multiple bare
   * images sent back to back accumulate here instead of replacing each
   * other, so several photos plus one caption become a single turn. In-
   * memory only (not persisted): images lost across a plugin reload/crash
   * before a caption or /skip arrives are simply gone, same as any other
   * in-flight bridge state - not worth the complexity of persisting them.
   */
  private pendingImages: IncomingImage[] = [];
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
   * Serializes getOrCreateWeChatTab() itself, not just sends against an
   * already-resolved tab. Needed specifically for the "no conversation bound
   * yet" (`this.data.conversationId === null`) branch: two /message calls
   * arriving close together (e.g. the WeChat user fires off two messages
   * before the first one's turn has created a conversation) would otherwise
   * each independently see "no tab yet" and call tabManager.createTab(),
   * spawning two separate conversations for what was meant to be one thread
   * - only the second call's tab ends up bound in data.conversationId, and
   * the first turn's reply is silently stranded on the discarded tab.
   */
  private getTabMutex: Promise<unknown> = Promise.resolve();
  /**
   * A single outstanding AskUserQuestion or approval request, surfaced via
   * pendingPushes and resolved by /answer or /approve. Adopted back from a
   * stale plugin instance across a reload via `__wechatPendingInteractive`
   * on the owning inputController - see installInteractiveHooks.
   */
  private pendingInteractive: PendingInteractive | null = null;
  /**
   * Per-tab progress cursor for /progressive mode, live only for the duration
   * of one queued send (created and torn down inside sendChatMessage). Tracks
   * how much of the in-flight turn's messages/blocks have already been
   * pushed to WeChat, so flushProgressive() only ever pushes each settled
   * chunk once.
   */
  private progressiveCursors: Map<string, { pushedMessageCount: number; pushedBlocksInCurrent: number; everPushed: boolean }> = new Map();
  /** Files queued by /send or /getfile, drained (ack-based, see AckQueue) by relay.py through /pending (same shape as pendingPushes for text). */
  private pendingFiles = new AckQueue<PendingFileItem>((items) => {
    this.data.pendingFileQueue = items;
    void this.saveData(this.data);
  });
  /**
   * The candidate list built by the most recent /files call, for /getfile N
   * to index into - same pattern as lastListedIds for /switch. Not
   * persisted (a reload losing "what /files last showed" is fine; just run
   * /files again).
   */
  private lastReferencedFiles: { display: string; absolutePath: string }[] = [];
  /** Loaded once in onload() from strings.json - see loadStrings(). */
  private strings: StringsData | null = null;

  async onload() {
    const saved = await this.loadData();
    this.data = { ...DEFAULT_DATA, ...(saved ?? {}) };

    // Rehydrate anything that was still queued-but-unacked when this plugin
    // last unloaded (see onunload's flush and AckQueue's onChange) - a
    // reload must not silently drop content relay.py hadn't fetched yet.
    // relay.py itself restarts alongside this plugin (RelayManager, below),
    // so its own ack bookkeeping restarts at the same point too; nothing on
    // its side needs to "catch up" past that.
    if (this.data.pendingPushQueue.length > 0) this.pendingPushes.push(...this.data.pendingPushQueue);
    if (this.data.pendingFileQueue.length > 0) this.pendingFiles.push(...this.data.pendingFileQueue);

    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      this.pluginDir = path.join(adapter.getBasePath(), this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`);
    }

    if (this.pluginDir) {
      await this.ensureEmbeddedAssets();
    }

    // Must happen before startServer(): handleIncoming() needs `this.strings`
    // for every reply it produces, including error replies to the very first
    // request. Kept as a plain JSON file next to main.js (see strings.json)
    // instead of a TS object literal so wording can be edited without
    // touching code or triggering a rebuild - a plain reload picks it up.
    await this.loadStrings();

    // Must finish (and, if it had to fall back to a non-default port, write
    // port.txt) before the relay is started, since relay.py reads that file
    // to know where to send messages.
    await this.startServer();

    this.registerInterval(window.setInterval(() => this.checkForDesktopActivity(), LISTEN_POLL_INTERVAL_MS));
    this.registerInterval(window.setInterval(() => this.checkScheduledSends(), LISTEN_POLL_INTERVAL_MS));

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
    // Flush whatever's in memory before the writes-in-flight it's built on
    // top of get cancelled by the unload itself. Most updates to `this.data`
    // (see checkForDesktopActivity, the /listen poller) call `void
    // this.saveData(this.data)` fire-and-forget on every tick rather than
    // awaiting it, since nothing in that hot loop can usefully block on a
    // disk write. That's fine as long as the plugin keeps running - the next
    // tick's write eventually lands - but a reload (disable+enable, or the
    // "Reload plugin" command) tears the plugin down immediately afterward;
    // if the in-flight write hadn't landed yet, data.json on disk is left
    // holding a stale, smaller `lastSeenMessageCount` than what was actually
    // already mirrored to WeChat. On the next load that stale count makes
    // checkForDesktopActivity think everything since it is still unseen and
    // re-push content the user already received - confirmed as the actual
    // cause of a real "为啥消息自动重发了" report, matching reload timestamps
    // in relay.log exactly to bursts of already-seen text reappearing. This
    // await guarantees the freshest in-memory state is the one actually on
    // disk by the time onload() runs again.
    await this.saveData(this.data);
    this.server?.close();
    this.server = null;
    this.relayManager?.stop();
  }

  /** Exposed for the settings tab (connection status, QR reconnect, restart/disconnect). */
  getRelayManager(): RelayManager | null {
    return this.relayManager;
  }

  /**
   * Ensures essential runtime assets (relay.py, strings.json) exist on disk.
   * - If installing fresh from the Obsidian Community Store (where only main.js
   *   and manifest.json are downloaded), this auto-extracts them on first load.
   * - If updating to a new release where either asset changed, this automatically
   *   overwrites the on-disk copy to keep them in lockstep with main.js.
   */
  private async ensureEmbeddedAssets(): Promise<void> {
    if (!this.pluginDir) return;
    await this.ensureFileMatches(path.join(this.pluginDir, 'relay.py'), EMBEDDED_RELAY_PY);
    await this.ensureFileMatches(path.join(this.pluginDir, STRINGS_FILE_NAME), EMBEDDED_STRINGS_JSON);
  }

  private async ensureFileMatches(targetPath: string, expectedContent: string): Promise<void> {
    try {
      const existing = await fs.readFile(targetPath, 'utf-8');
      if (existing === expectedContent) return;
    } catch {
      // Missing or unreadable: proceed to write
    }
    try {
      await fs.writeFile(targetPath, expectedContent, 'utf-8');
    } catch (e) {
      console.error(`[claudian-wechat] Failed to write embedded asset ${targetPath}:`, e);
    }
  }

  // ---- i18n: strings.json loading + lookup ----

  /**
   * Reads strings.json from the plugin folder (same place as main.js and
   * manifest.json - `this.pluginDir`). Falls back to an empty table (every
   * `t()` call then returns a visibly-broken `[[missing: key]]` placeholder
   * instead of throwing) rather than blocking the whole plugin on a single
   * malformed or missing file - a bridge that replies with placeholder text
   * is still debuggable; one that fails onload() entirely is not.
   */
  private async loadStrings(): Promise<void> {
    if (!this.pluginDir) {
      this.strings = { help: { zh: [], en: [] } };
      return;
    }
    try {
      const raw = await fs.readFile(path.join(this.pluginDir, STRINGS_FILE_NAME), 'utf-8');
      this.strings = JSON.parse(raw) as StringsData;
    } catch (e) {
      new Notice(`WeChat Bridge: failed to load ${STRINGS_FILE_NAME} (${e instanceof Error ? e.message : e})`);
      this.strings = { help: { zh: [], en: [] } };
    }
  }

  /**
   * Looks up `key` in strings.json for `lang` and substitutes `{0}`, `{1}`,
   * ... with `args` in order - the single call site every reply string in
   * this file goes through (replaces the old `pick(STRINGS.x, lang)(...)`
   * pattern; wording itself now lives entirely in strings.json, not here).
   */
  private t(key: string, lang: Lang, ...args: (string | number)[]): string {
    const entry = this.strings?.[key];
    if (!entry || Array.isArray(entry.zh)) return `[[missing string: ${key}]]`;
    const template = (entry as { zh: string; en: string })[lang];
    return args.length === 0 ? template : template.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
  }

  /** /help text. Only mentions /provider when more than one provider is actually enabled in Claudian.
   * The optional `?`-prefixed line in strings.json's help.zh/help.en is that /provider line; stripped
   * (and un-prefixed) here based on `showProviderCommand` instead of duplicating the whole list twice. */
  private buildHelpText(lang: Lang, showProviderCommand: boolean): string {
    const lines = this.strings?.help[lang] ?? [];
    return lines
      .filter((line) => !line.startsWith('?') || showProviderCommand)
      .map((line) => (line.startsWith('?') ? line.slice(1) : line))
      .join('\n');
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
      if (req.method === 'GET' && req.url?.startsWith('/pending')) {
        // See AckQueue's doc comment: this used to clear both queues
        // unconditionally on every GET, which silently lost content whenever
        // the response didn't actually make it back to relay.py. Ack query
        // params let the client confirm what it actually finished
        // processing from the *previous* response before anything is
        // removed - anything unacked simply comes back in `pushes`/`files`
        // again below.
        const query = new URL(req.url, 'http://localhost').searchParams;
        const ackPush = query.get('ackPush');
        const ackFiles = query.get('ackFiles');
        if (ackPush !== null) this.pendingPushes.ack(Number(ackPush));
        if (ackFiles !== null) this.pendingFiles.ack(Number(ackFiles));

        const pushes = this.pendingPushes.snapshot().map(({ id, item }) => ({ id, text: item }));
        const files = this.pendingFiles.snapshot().map(({ id, item }) => ({ id, ...item }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        // `listening` lets the relay back off its poll rate while /listen is
        // off, instead of hitting this endpoint at a fixed interval forever
        // regardless of whether the feature is even in use.
        res.end(JSON.stringify({ ok: true, pushes, files, listening: this.data.listening, progressive: this.data.progressiveReply }));
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

    // Node 18+'s http.Server defaults to killing any request that takes
    // longer than 5 minutes end-to-end (`requestTimeout`), and any idle
    // connection past 5 minutes (`server.timeout`) - both meant for public-
    // facing servers guarding against slow-loris-style abuse, neither
    // relevant to a 127.0.0.1-only bridge. A real agentic Claudian turn
    // (several tool calls, a long-running build, etc.) can easily run past
    // 5 minutes: the request would then get killed *after* Claudian actually
    // finished and replied, but *before* that reply could be written to the
    // response - relay.py would see the connection reset (not a clean error,
    // just a dead socket) and the WeChat side would get nothing at all, with
    // no visible error, even though Claudian's own UI shows the turn
    // completed fine. Disabling both removes that ceiling entirely; nothing
    // else here depends on either timeout existing.
    server.requestTimeout = 0;
    server.timeout = 0;

    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      const candidate = PREFERRED_PORT + attempt;
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
      throw new Error(this.t('bodyMustBeJson', this.getLangSafe()));
    }
    const lang = this.getLangSafe();
    // A pure image message (no caption) has empty text - only reject the
    // request if there's neither text nor an image to act on.
    if (!text && !image) throw new Error(this.t('emptyText', lang));

    // A bare image (no caption in the same WeChat message) is not sent as
    // its own isolated turn right away - it's appended to a buffer, waiting
    // for a follow-up caption, until either one arrives as plain text or the
    // user explicitly sends it on its own with /skip. Multiple bare images
    // sent back to back (WeChat has no built-in multi-select-with-one-
    // caption flow) accumulate in the same buffer instead of replacing each
    // other, so "send 3 photos, then one caption" becomes a single turn with
    // all 3 images. No auto-timeout: a silent timed auto-send surprised more
    // than it helped (WeChat's own timing between picking photos and typing
    // a caption is unpredictable), and there's no way to guess *when* the
    // user is done adding photos or gave up on typing a caption, so it just
    // doesn't guess - see /skip below for the explicit "I'm done" signal.
    if (image && !text) {
      this.pendingImages.push(image);
      return this.t('imageBufferedWaitingCaption', lang);
    }

    // A plain text message (not a bridge command) arriving while images are
    // still buffered is treated as their caption - combine them into one
    // turn instead of disjoint ones.
    let images: IncomingImage[] | undefined = image ? [image] : undefined;
    if (this.pendingImages.length > 0 && text && !text.startsWith('/')) {
      images = this.pendingImages;
      this.pendingImages = [];
    }

    // Every bridge command is tried, in order, against `text`; the first
    // whose `match` succeeds runs and its result is the reply. None of these
    // touch sendChatMessageQueued - every one of them either reads in-memory
    // state directly or is explicitly meant to run immediately rather than
    // wait behind an in-flight chat turn (most importantly /answer, /approve
    // and /esc, which exist specifically to unblock or interrupt one).
    // Anything matching none of them (including Claude's own slash commands
    // like /compact, vault commands, and skills) falls through to the
    // regular queued chat send at the bottom - Claudian's own InputController
    // already detects and expands those, so this bridge does not special-
    // case them.
    for (const route of this.commandRoutes()) {
      const m = text.match(route.pattern);
      if (m) return await route.run(m, lang, images);
    }

    return await this.sendChatMessageQueued(text, lang, images);
  }

  /** Handles `/skip`: sends every still-buffered image (see handleIncoming) on its own, right now, with no caption. */
  private async handleSkipCaptionCommand(lang: Lang): Promise<string> {
    const images = this.pendingImages;
    if (images.length === 0) return this.t('noPendingImage', lang);
    this.pendingImages = [];
    return await this.sendChatMessageQueued('', lang, images);
  }

  /**
   * Declarative table backing handleIncoming(): one entry per bridge slash
   * command, tried top-to-bottom against the inbound text. Built fresh per
   * call (cheap - a few dozen closures) rather than cached, so every `run`
   * can close over `this` without a separate bind step.
   */
  private commandRoutes(): { pattern: RegExp; run: (m: RegExpMatchArray, lang: Lang, images?: IncomingImage[]) => Promise<string> | string }[] {
    return [
      { pattern: /^\/answer\b/i, run: (m, lang) => this.handleAnswerCommand(m.input as string, lang) },
      { pattern: /^\/approve\b/i, run: (m, lang) => this.handleApproveCommand(m.input as string, lang) },
      { pattern: /^\/esc\b/i, run: (_m, lang) => this.handleEscCommand(lang) },
      { pattern: /^\/skip\b/i, run: (_m, lang) => this.handleSkipCaptionCommand(lang) },
      { pattern: /^\/files\b/i, run: (_m, lang) => this.listReferencedFiles(lang) },
      { pattern: /^\/getfile\b/i, run: (m, lang) => this.handleGetFileCommand(m.input as string, lang) },
      { pattern: /^\/send\s+(\S.*)$/i, run: (m, lang) => this.handleSendCommand(m[1].trim(), lang) },
      { pattern: /^\/send\b/i, run: (_m, lang) => this.t('sendUsage', lang) },
      { pattern: /^\/schedule\s+(\S.*)$/i, run: (m, lang) => this.handleScheduleCommand(m[1].trim(), lang) },
      { pattern: /^\/schedule\b/i, run: (_m, lang) => this.t('scheduleUsage', lang) },
      { pattern: /^\/help\b/i, run: (_m, lang) => this.buildHelpText(lang, this.getEnabledProviders().length > 1) },
      { pattern: /^\/commands\b/i, run: (_m, lang) => this.listClaudeCommands(lang) },
      {
        pattern: /^\/(model|effort|permission)\s+(\S+)/i,
        run: (_m, lang) => {
          const settingsCmd = this.parseSettingsCommand(_m.input as string);
          // Always non-null here - the route's own pattern is a superset of
          // parseSettingsCommand's, so a match on one implies a match on the
          // other. Re-parsing (rather than duplicating its key-mapping logic
          // inline) keeps that mapping defined in exactly one place.
          return this.applySettingsCommand(settingsCmd!.key, settingsCmd!.value, lang);
        },
      },
      { pattern: /^\/effort\s*$/i, run: (_m, lang) => this.listEffortOptions(lang) },
      { pattern: /^\/provider\s+(\S+)/i, run: (m, lang) => this.switchProvider(m[1].toLowerCase(), lang) },
      { pattern: /^\/provider\b/i, run: (_m, lang) => this.t('providerUsage', lang, this.getEnabledProviders().join(', ')) },
      { pattern: /^\/models\s*(\S+)?\b/i, run: (m, lang) => this.listAvailableModels(m[1]?.toLowerCase(), lang) },
      { pattern: /^\/ls(?:\s+(all))?\b/i, run: (m, lang) => this.listConversations(lang, Boolean(m[1])) },
      { pattern: /^\/goto\s+(\d+)/i, run: (m, lang) => this.switchConversation(Number(m[1]), lang) },
      { pattern: /^\/status\b/i, run: (_m, lang) => this.statusText(lang) },
      { pattern: /^\/hist\s+(\d+)\b/i, run: (m, lang) => this.showHistory(Number(m[1]), lang) },
      { pattern: /^\/hist\b/i, run: (_m, lang) => this.listHistory(lang) },
      { pattern: /^\/listen\s+(on|off)\b/i, run: (m, lang) => this.setListening(m[1].toLowerCase() === 'on', lang) },
      { pattern: /^\/listen\b/i, run: (_m, lang) => this.t('listenUsage', lang) },
      {
        pattern: /^\/progressive\s+(on|off)\b/i,
        run: async (m, lang) => {
          this.data.progressiveReply = m[1].toLowerCase() === 'on';
          await this.saveData(this.data);
          return this.t(this.data.progressiveReply ? 'progressiveOn' : 'progressiveOff', lang);
        },
      },
      { pattern: /^\/progressive\b/i, run: (_m, lang) => this.t('progressiveUsage', lang) },
      {
        pattern: /^\/new\b/i,
        run: async (_m, lang) => {
          this.data.conversationId = null;
          await this.saveData(this.data);
          return this.t('newConversationStarted', lang);
        },
      },
    ];
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
    // Must resolve the tab manager that actually owns `tab` - with dual-pane
    // (2.1.0+) that isn't necessarily getAllViews()[0] (see the same concern
    // in getOrCreateWeChatTab). getSdkCommands(tab.id) against the wrong
    // pane's tab manager would look up an id it's never seen.
    const found = this.data.conversationId
      ? this.getClaudianPlugin().findConversationAcrossViews?.(this.data.conversationId)
      : null;
    const view = found?.view ?? (this.getClaudianPlugin().getAllViews?.() ?? [])[0] ?? this.findClaudianViewViaWorkspace();
    const tabManager = view?.getTabManager?.();
    if (!tabManager) throw new Error(this.t('noTabManager', lang));

    const commands = await tabManager.getSdkCommands(tab.id);
    if (commands.length === 0) return this.t('noClaudeCommands', lang);

    const lines: string[] = [this.t('claudeCommandsHeader', lang)];
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

    if (key === 'effortLevel') {
      const settings = claudian.settings ?? {};
      const isActiveInUi = providerId === (settings.settingsProvider ?? 'claude');
      const model = isActiveInUi ? settings.model : settings.savedProviderModel?.[providerId];
      const known = this.getKnownEffortOptions(providerId, model, settings);
      if (known && !known.some((o) => o.value === value)) {
        return this.t('effortInvalid', lang, value, known.map((o) => o.value).join(', '));
      }
    }

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
      ? `${this.t('providerLabel', lang)}${providerId}, `
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
      return this.t('providerUnknown', lang, name, enabled.join(', '));
    }
    this.data.providerId = name as ProviderId;
    // A bound conversation's provider can't be changed after the fact
    // (Claudian itself rejects that from its own UI); switching provider
    // here always means "start fresh", same as /new.
    this.data.conversationId = null;
    await this.saveData(this.data);
    return this.t('providerSwitched', lang, name);
  }

  /**
   * Lists the models Claudian currently knows about for a provider (default:
   * whichever one /model would target right now).
   *
   * Reverse-engineered source: for the CLI-backed providers (codex, pi,
   * opencode, grok - anything but claude), Claudian doesn't ship a static
   * model list at all. It shells out to that provider's CLI to discover what
   * models are actually available on this machine/account, then caches the
   * result at `settings.providerConfigs.<id>.discoveredModels` (each entry
   * `{model, displayName, description, isDefault, ...}` - see
   * ProviderSettingsCoordinator's normalizeStored/DXe in Claudian's own
   * main.js). That cache is plain persisted settings data, unlike the
   * registry class that computes it (a module-private static class not
   * reachable from outside Claudian's own bundle) - so this reads the cache
   * directly instead of trying to call Claudian's internal discovery API.
   * `claude` has no such cache (its model list is a small built-in constant
   * baked into Claudian's UI code, not discovered) so it's called out
   * separately rather than guessed at and hardcoded here - hardcoding it
   * would just trade today's problem for a future silent-staleness one.
   */
  private async listAvailableModels(providerArg: string | undefined, lang: Lang): Promise<string> {
    const enabled = this.getEnabledProviders();
    let providerId: ProviderId;
    if (providerArg) {
      if (!(enabled as string[]).includes(providerArg)) {
        return this.t('providerUnknown', lang, providerArg, enabled.join(', '));
      }
      providerId = providerArg as ProviderId;
    } else {
      providerId = this.resolveActiveProviderId(await this.readAllConversationMeta());
    }

    const settings = this.getClaudianPlugin().settings ?? {};
    if (providerId === 'claude') {
      return this.t('modelsClaudeBuiltin', lang);
    }

    const discovered = settings.providerConfigs?.[providerId]?.discoveredModels;
    if (!Array.isArray(discovered) || discovered.length === 0) {
      return this.t('modelsNoneDiscovered', lang, providerId);
    }

    const isActiveInUi = providerId === (settings.settingsProvider ?? 'claude');
    const current = isActiveInUi ? settings.model : settings.savedProviderModel?.[providerId];

    const lines = [this.t('modelsHeader', lang, providerId)];
    for (const entry of discovered) {
      const id = typeof entry?.model === 'string' ? entry.model : null;
      if (!id) continue;
      const displayName = typeof entry?.displayName === 'string' && entry.displayName ? entry.displayName : id;
      const markers = [
        entry?.isDefault ? this.t('modelsDefaultMarker', lang) : '',
        id === current ? this.t('modelsCurrentMarker', lang) : '',
      ].filter(Boolean).join(' ');
      lines.push(`- ${id}${displayName !== id ? ` (${displayName})` : ''}${markers ? ` ${markers}` : ''}`);
    }
    lines.push('\n' + this.t('modelsUsageHint', lang));
    return lines.join('\n');
  }

  /**
   * Providers whose valid effort levels are a fixed, model-independent list
   * baked into Claudian's own UI (reverse-engineered from Claudian's bundle:
   * claude's thinking-gear list and codex's subagent reasoning-effort
   * dropdown are both this exact 5-value set). Not model-dependent the way
   * claude's `xhigh` availability technically is in Claudian's own code
   * (there's a per-model-version check gating it) - we deliberately don't
   * replicate that finer-grained check here (see class doc comment risk
   * notes), so a `claude` model that doesn't actually support `xhigh` will
   * still list it as "valid" here even though Claudian's own UI would hide
   * it for that specific model.
   */
  private static readonly STATIC_EFFORT_LEVELS: { value: string; label: string }[] =
    ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value }));

  /**
   * Best-effort lookup of the effort/reasoning levels Claudian actually
   * considers valid for `modelId` under `providerId` right now - used to
   * validate `/effort X` instead of blindly writing whatever the user typed.
   *
   * Returns `null` when we have no reliable source for this provider (currently:
   * `pi`, whose settings cache only remembers the last-used value per model via
   * `preferredThinkingByModel`, not the full set of valid ones) - callers should
   * skip validation entirely in that case rather than reject everything.
   *
   * Source per provider (see class doc comment for how this was derived):
   * - claude / codex: fixed list, independent of the specific model.
   * - grok / opencode: each entry in `providerConfigs.<id>.discoveredModels`
   *   carries its own `reasoningEfforts` array once Claudian has discovered
   *   it - same persisted-cache source `/models` already reads model names
   *   from, just a different field on the same objects.
   * - pi: no equivalent field exists in what Claudian persists - see above.
   */
  private getKnownEffortOptions(
    providerId: ProviderId,
    modelId: string | undefined,
    settings: Record<string, any>,
  ): { value: string; label: string }[] | null {
    if (providerId === 'claude' || providerId === 'codex') {
      return WeChatBridgePlugin.STATIC_EFFORT_LEVELS;
    }
    if (providerId === 'pi') {
      return null;
    }
    // grok, opencode
    if (!modelId) return null;
    const discovered = settings.providerConfigs?.[providerId]?.discoveredModels;
    if (!Array.isArray(discovered)) return null;
    const entry = discovered.find((m: any) => m?.model === modelId || m?.rawId === modelId);
    const efforts = entry?.reasoningEfforts;
    if (!Array.isArray(efforts) || efforts.length === 0) return null;
    return efforts
      .map((e: any) => {
        const value = typeof e?.value === 'string' ? e.value : typeof e === 'string' ? e : null;
        if (!value) return null;
        const label = typeof e?.label === 'string' && e.label ? e.label : value;
        return { value, label };
      })
      .filter((e: { value: string; label: string } | null): e is { value: string; label: string } => e !== null);
  }

  /** `/effort` with no args: lists the effort levels valid for whatever /model would target right now, per getKnownEffortOptions. */
  private async listEffortOptions(lang: Lang): Promise<string> {
    const settings = this.getClaudianPlugin().settings ?? {};
    const metas = await this.readAllConversationMeta();
    const providerId = this.resolveActiveProviderId(metas);
    const isActiveInUi = providerId === (settings.settingsProvider ?? 'claude');
    const model = isActiveInUi ? settings.model : settings.savedProviderModel?.[providerId];
    const current = isActiveInUi ? settings.effortLevel : settings.savedProviderEffort?.[providerId];

    const known = this.getKnownEffortOptions(providerId, model, settings);
    if (!known) {
      return this.t('effortUnknown', lang, providerId);
    }
    const lines = [this.t('effortHeader', lang, providerId)];
    for (const o of known) {
      const marker = o.value === current ? this.t('modelsCurrentMarker', lang) : '';
      lines.push(`- ${o.value}${o.label !== o.value ? ` (${o.label})` : ''}${marker ? ` ${marker}` : ''}`);
    }
    lines.push('\n' + this.t('effortUsageHint', lang));
    return lines.join('\n');
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
    metas.sort((a, b) => conversationSortKey(b) - conversationSortKey(a));
    this.metaCache = { at: Date.now(), metas };
    return metas;
  }

  private async listConversations(lang: Lang, showAll: boolean): Promise<string> {
    const metas = await this.readAllConversationMeta();
    // Always recorded in full (not truncated to what's displayed) so /switch
    // N still resolves correctly for any N within the real list, even one
    // past what a default (non-"all") /list actually printed.
    this.data.lastListedIds = metas.map((m) => m.id);
    void this.saveData(this.data);

    if (metas.length === 0) return this.t('noConversations', lang);

    const shown = showAll ? metas : metas.slice(0, LIST_DEFAULT_LIMIT);
    const localeTag = lang === 'zh' ? 'zh-CN' : 'en-US';
    const lines = shown.map((m, i) => {
      const marker = m.id === this.data.conversationId ? this.t('current', lang) : '';
      const key = conversationSortKey(m);
      const when = key ? new Date(key).toLocaleString(localeTag) : '';
      return `${i + 1}. ${m.title || this.t('untitled', lang)}${marker} — ${when}`;
    });
    if (!showAll && metas.length > LIST_DEFAULT_LIMIT) {
      lines.push(this.t('listTruncated', lang, metas.length - LIST_DEFAULT_LIMIT));
    }
    return lines.join('\n');
  }

  private async switchConversation(index: number, lang: Lang): Promise<string> {
    const ids = this.data.lastListedIds;
    if (ids.length === 0) return this.t('switchNeedsListFirst', lang);
    const id = ids[index - 1];
    if (!id) return this.t('outOfRange', lang, ids.length);

    this.data.conversationId = id;
    await this.saveData(this.data);

    // Eagerly resolve/open the tab now so the switch fails fast if something's wrong,
    // instead of silently failing on the next chat message.
    const tab = await this.getOrCreateWeChatTab();
    const metas = await this.readAllConversationMeta();
    const title = this.titleFor(tab.conversationId, metas);
    return this.t('switchedTo', lang, title);
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

    const base = this.t('statusTemplate', lang, 
      String(model ?? '?'),
      String(effort ?? '?'),
      String(permission ?? '?'),
    );
    const providerLine = this.getEnabledProviders().length > 1
      ? `\n${this.t('providerLabel', lang)}${providerId}`
      : '';
    const listeningWord = this.data.listening
      ? this.t('statusListeningOn', lang)
      : this.t('statusListeningOff', lang);
    const progressiveWord = this.data.progressiveReply
      ? this.t('statusListeningOn', lang)
      : this.t('statusListeningOff', lang);
    // Reuses the same usage lookup real turn replies append - /status just
    // reads it on demand instead of waiting for a turn to trigger it.
    const ctxLine = await this.contextWindowLine(this.data.conversationId, lang);
    const ctxSuffix = ctxLine ? `\n${ctxLine}` : '';
    return `${base}${providerLine}\n${this.t('statusListeningLabel', lang)}${listeningWord}\n${this.t('statusProgressiveLabel', lang)}${progressiveWord}${ctxSuffix}`;
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
          this.data.lastSeenConversationId = tab.conversationId;
        } catch {
          this.data.lastSeenMessageCount = 0;
          this.data.lastSeenConversationId = this.data.conversationId;
        }
      } else {
        this.data.lastSeenMessageCount = 0;
        this.data.lastSeenConversationId = null;
      }
    }
    await this.saveData(this.data);
    return this.t(on ? 'listenOn' : 'listenOff', lang);
  }

  /**
   * Runs on a timer (same cadence as checkForDesktopActivity). Fires any
   * /schedule entry whose nextFireAt has passed: pushes its text straight to
   * pendingPushes (drained by relay.py's next /pending poll, same as every
   * other proactive push in this file) and either removes it (one-shot) or
   * rolls nextFireAt forward by its repeat rule (recurring) so it fires again
   * next time around. Deliberately does not touch Claudian/sendChatMessage at
   * all - a scheduled send is a local alarm, not an AI turn.
   */
  private async checkScheduledSends(): Promise<void> {
    if (this.data.scheduledSends.length === 0) return;
    const now = Date.now();
    const due = this.data.scheduledSends.filter((s) => s.nextFireAt <= now);
    if (due.length === 0) return;

    let changed = false;
    for (const entry of due) {
      this.pendingPushes.push(entry.text);
      if (entry.repeat?.type === 'daily') {
        // Roll forward a whole number of days from the missed slot (not just
        // "+1 day from now") so a brief Obsidian outage across the fire time
        // doesn't drift the daily time of day.
        let next = entry.nextFireAt;
        while (next <= now) next += 24 * 60 * 60 * 1000;
        entry.nextFireAt = next;
      } else {
        this.data.scheduledSends = this.data.scheduledSends.filter((s) => s.id !== entry.id);
      }
      changed = true;
    }
    if (changed) await this.saveData(this.data);
  }

  /**
   * Runs on a timer. Two independent things happen here, both driven off the
   * same message-count-growth detection:
   *
   *  1. Autonomous continuations of the currently WeChat-bound conversation
   *     (a scheduled/cron wakeup resuming it, a background task finishing,
   *     etc.) - these are mirrored unconditionally, regardless of /listen.
   *     This conversation *is* the WeChat conversation; if Claudian says
   *     something new in it, WeChat should hear it no matter what triggered
   *     that turn. Gating this behind /listen (as an earlier version of this
   *     function did) was the actual bug behind a real user report: such
   *     replies showed up in Claudian's desktop UI but never reached WeChat,
   *     because /listen is normally left off (it's a separate opt-in for
   *     mirroring desktop-*typed* prompts, and most WeChat-only usage never
   *     turns it on).
   *  2. Desktop-typed prompts (a message with a `role: 'user'` entry in the
   *     growth) - mirroring *these* is the actual /listen feature described
   *     in listenOn's string, and stays gated on it plus its own
   *     conversation scoping (listeningConversationId), so toggling /listen
   *     on in one conversation doesn't silently start following a different
   *     one later just because it happens to be the bound one by then.
   */
  private async checkForDesktopActivity(): Promise<void> {
    if (!this.data.conversationId) return;

    // /listen's own scope tracking (opt-in, feature #2 above) - independent
    // of the resync logic below, which tracks whichever conversation is
    // *currently* bound for feature #1 regardless of /listen.
    if (this.data.listening) {
      if (this.data.listeningConversationId === null) {
        this.data.listeningConversationId = this.data.conversationId;
        void this.saveData(this.data);
      }
    }
    const listenScopeOk = this.data.listening && this.data.listeningConversationId === this.data.conversationId;

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

    // lastSeenMessageCount is only meaningful against the conversation it was
    // counted for. If the bound conversation changed since the last tick
    // (via /switch, /new, or a blank tab just getting assigned its first real
    // id), resync to the current end instead of comparing counts across two
    // unrelated conversations - that would either replay the "new" one's
    // entire history as if it just happened, or (if it happens to be longer)
    // silently swallow real growth because the stale count is already past
    // it.
    if (this.data.lastSeenConversationId !== tab.conversationId) {
      this.data.lastSeenConversationId = tab.conversationId;
      this.data.lastSeenMessageCount = messages.length;
      void this.saveData(this.data);
      return;
    }

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

    // A typed-in-desktop turn always has a `user` message in the growth; a
    // turn Claudian ran on its own initiative (a scheduled/cron wakeup
    // resuming this same conversation, an autonomous continuation, etc.)
    // does not - it's pure assistant output appended without anything the
    // bridge would recognize as a prompt. This used to be treated as "no new
    // turn, discard" (comment: "Pure assistant-only growth (e.g. a resumed
    // stream); nothing new to report"), which was really working around a
    // *different* bug: before onunload() flushed data.json on every plugin
    // reload (see that fix), a reload could leave lastSeenMessageCount stale
    // on disk, and Claudian reloading/re-populating its own message array
    // afterward would look exactly like "assistant-only growth" even though
    // nothing new had actually happened - discarding it was the safe
    // default. Now that staleness is fixed at the source, the only thing
    // still reaching this branch in practice is a genuine no-prompt turn,
    // and silently dropping it is a real gap, not a safety net: a scheduled
    // wakeup that fires a reply is exactly the kind of thing worth mirroring,
    // and confirmed via user report as arriving in Claudian but never
    // reaching WeChat. A prompted turn, on the other hand, only gets mirrored
    // when /listen is explicitly on and scoped to this conversation (see
    // listenScopeOk above) - see feature #2 in this function's doc comment.
    const promptMsg = newMessages.find((m) => m.role === 'user');
    if (promptMsg && !listenScopeOk) return;

    const lang = this.getLangSafe();
    const { text: reply, compacted } = this.extractDispatchText(newMessages, lang);
    if (!reply.trim()) return; // Genuinely nothing new (e.g. a compact boundary with no narrative text) - see extractDispatchText.

    const metas = await this.readAllConversationMeta();
    const title = this.titleFor(tab.conversationId, metas);
    // Right after a /compact, Claudian's own conversation-meta usage numbers
    // haven't necessarily caught up yet, so appending them here would show
    // the *pre-compact* context size right next to a "context was compacted"
    // message - confusing, and the opposite of what that line is for. Skip it
    // for compact turns; the point of this reply is just "compaction
    // succeeded", not a token count.
    const ctxLine = compacted ? null : await this.contextWindowLine(tab.conversationId, lang);
    const body = ctxLine ? `${reply}\n\n${ctxLine}` : reply;
    this.pendingPushes.push(
      promptMsg
        ? this.t('desktopTurnTemplate', lang, title, promptMsg.content.trim(), body)
        : this.t('desktopAutoTurnTemplate', lang, title, body),
    );
  }

  // ---- history: list past turns in the current conversation, and view one reply ----

  private getUserMessageIndices(messages: ClaudianChatMessage[]): number[] {
    const indices: number[] = [];
    messages.forEach((m, i) => {
      if (m.role === 'user') indices.push(i);
    });
    return indices;
  }

  /** Shared by every call site that needs "the title of this conversation, or
   * something reasonable if it has none" - the raw id as a last resort,
   * '?' only if there's no id at all. */
  private titleFor(conversationId: string | null, metas: ConversationMeta[]): string {
    return metas.find((m) => m.id === conversationId)?.title ?? conversationId ?? '?';
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
    // Explicit null/undefined checks, not `!usage.contextTokens` - a
    // conversation that has genuinely used 0 tokens so far (e.g. right after
    // /new, before the first reply's usage lands in meta) has
    // contextTokens === 0, which is falsy but not "no data yet".
    if (usage?.contextTokens == null || !usage?.contextWindow) return null;
    return this.t('contextWindowLine', lang, 
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
    if (userIndices.length === 0) return this.t('histEmpty', lang);

    const lines: string[] = [this.t('histHeader', lang)];
    userIndices.forEach((msgIndex, i) => {
      lines.push(`${i + 1}. ${this.truncate(messages[msgIndex].content, 40)}`);
    });
    return lines.join('\n');
  }

  private async showHistory(index: number, lang: Lang): Promise<string> {
    const tab = await this.getOrCreateWeChatTab();
    const messages = tab.state.messages;
    const userIndices = this.getUserMessageIndices(messages);
    if (userIndices.length === 0) return this.t('histEmpty', lang);

    const msgIndex = userIndices[index - 1];
    if (msgIndex === undefined) return this.t('outOfRange', lang, userIndices.length);

    // Same reply-filtering rule as a live turn: only the assistant's final
    // text is shown, from just after this user message up to the next one.
    const nextUserIndex = userIndices[index] ?? messages.length;
    const turnMessages = messages.slice(msgIndex + 1, nextUserIndex);
    return this.extractDispatchText(turnMessages, lang).text;
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
  private async sendChatMessageQueued(text: string, lang: Lang, images?: IncomingImage[]): Promise<string> {
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
    const run = previous.catch(() => {}).then(() => this.sendChatMessage(tab, text, lang, images, conversationIdAtQueueTime));
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
    images: IncomingImage[] | undefined,
    conversationIdAtQueueTime: string | null,
  ): Promise<string> {
    if (!tab.controllers.inputController) {
      throw new Error(this.t('tabNotReady', lang));
    }

    // Instead of trusting the tab object resolved back when this send was
    // queued (which may have since been repurposed by a desktop-side
    // conversation switch happening *in that exact tab* - see
    // resolveOrCreateTab's doc comment), re-locate the actual tab for
    // conversationIdAtQueueTime right before sending, the same way /goto
    // finds a conversation's tab: by id, across every pane, reopening it if
    // it was closed - rather than a raw JS-object reference that can go
    // stale. This shrinks the "sent into the wrong conversation" window to
    // effectively zero instead of merely detecting it after the fact.
    if (conversationIdAtQueueTime) {
      tab = await this.getOrCreateTabForConversation(conversationIdAtQueueTime);
      if (!tab.controllers.inputController) throw new Error(this.t('tabNotReady', lang));
    }

    this.sendingViaBridgeTabIds.add(tab.id);
    try {
      // The user's currently-open note in Obsidian - whatever that happens to
      // be, unrelated to this conversation - would otherwise silently ride
      // along as `<linked_note>` context on this send (see ClaudianTab.ui's
      // fileContextManager doc comment for why). WeChat has no way to see or
      // veto that, so pre-empt it before every bridge-driven send.
      //
      // Guarded with a typeof check (not just `?.`) because this was
      // reverse-engineered from Claudian's internals: if a Claudian update
      // renames/removes/changes the shape of fileContextManager, `?.` alone
      // would still throw "markCurrentNoteSent is not a function" and abort
      // the whole send - best-effort here, a missed pre-empt is much less
      // bad than silently failing to deliver the user's message at all.
      if (typeof tab.ui.fileContextManager?.markCurrentNoteSent === 'function') {
        tab.ui.fileContextManager.markCurrentNoteSent();
      }

      const beforeCount = tab.state.messages.length;
      // Reconstruct the same shape Claudian's own paste/drop handler builds
      // (id/name/mediaType/data/size/source) - inputController.sendMessage
      // doesn't care how an image got attached, only that it matches this shape.
      const attachments: ClaudianImageAttachment[] | undefined = images && images.length > 0
        ? images.map((image, i) => ({
            id: `wechat-${Date.now()}-${i}`,
            name: `wechat-image-${i}.${image.mediaType.split('/')[1] ?? 'jpg'}`,
            mediaType: image.mediaType,
            data: image.data,
            size: Math.ceil((image.data.length * 3) / 4),
            source: 'wechat' as const,
          }))
        : undefined;

      const progressive = this.data.progressiveReply;
      let progressiveTimer: number | null = null;
      let pushedAnything = false;
      if (progressive) {
        this.progressiveCursors.set(tab.id, { pushedMessageCount: 0, pushedBlocksInCurrent: 0, everPushed: false });
        progressiveTimer = window.setInterval(() => this.flushProgressive(tab, beforeCount, false), PROGRESSIVE_POLL_INTERVAL_MS);
      }
      try {
        await tab.controllers.inputController.sendMessage({ content: text, images: attachments });
      } finally {
        if (progressiveTimer !== null) window.clearInterval(progressiveTimer);
        if (progressive) {
          // Unverified-but-cheap safety margin: inputController.sendMessage()'s
          // promise is trusted to resolve only once the whole turn is done
          // (extractDispatchText has relied on that for non-progressive
          // replies since before /progressive existed, with no truncation
          // reports), but if Claudian has *any* async "commit the streaming
          // buffer to its final form" step that runs after that promise
          // resolves - the same category of race /listen originally had
          // with isStreaming - reading tab.state.messages at the instant the
          // promise resolves could catch the second-to-last version of the
          // final block, silently missing the last bit of text. A short
          // grace delay before the final read is a no-cost way to not care
          // whether that's true.
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          // Computed here, before the final flush, so it can ride along on
          // the very last chunk instead of arriving as its own separate
          // WeChat message (flushProgressive appends it to the last line it
          // pushes this call). Final flush treats the very last block as
          // settled too (it can no longer still be growing - the turn is
          // over), so nothing produced right at the tail end between the
          // last poll tick and completion gets missed.
          // Same staleness concern as the non-progressive path below: right
          // after a /compact the meta usage numbers may not have caught up
          // yet, so skip the context-window line for a compact turn here too.
          const turnSoFar = tab.state.messages.length >= beforeCount ? tab.state.messages.slice(beforeCount) : tab.state.messages;
          const dispatchSoFar = this.extractDispatchText(turnSoFar, lang);
          const ctxLineForFlush = dispatchSoFar.compacted ? null : await this.contextWindowLine(tab.conversationId, lang);
          // `dispatchSoFar.empty` means the whole turn - not just this poll
          // tick - never produced any real narrative text (and it wasn't a
          // legitimate no-text /compact either). Previously this fell
          // through silently: flushProgressive had nothing to attach the
          // context-window line to, so it just sent that bare number on its
          // own, which reads exactly like a normal (if terse) reply - a
          // turn that genuinely failed partway (e.g. a stale/detached tab
          // reference, or the provider erroring after sendMessage() had
          // already resolved) looked identical to "worked fine, nothing
          // to say". Surface extractDispatchText's own "did this fail?"
          // warning here too so that silent-failure case is never mistaken
          // for success again.
          const suffixForFlush = dispatchSoFar.empty
            ? `${dispatchSoFar.text}${ctxLineForFlush ? `\n\n${ctxLineForFlush}` : ''}`
            : (ctxLineForFlush ?? undefined);
          pushedAnything = this.flushProgressive(tab, beforeCount, true, suffixForFlush);
          this.progressiveCursors.delete(tab.id);
        }
      }

      // Switched away *during* the send: the freshly-relocated `tab` above
      // still got mutated out from under this exact call while
      // sendMessage() was awaiting (the desktop switched conversations *in
      // that same tab* again, mid-flight) - the message already went to
      // inputController.sendMessage() on that object, so this can't be
      // prevented, only reported. Don't guess at a normal reply here (it
      // might be a stale/wrong-conversation context-window line) - instead
      // re-locate conversationIdAtQueueTime by id one more time, the same
      // /goto-style lookup used above: Claudian persists each conversation's
      // messages independently of which tab object currently has it open,
      // so this reliably finds (or, if closed, reopens straight from disk)
      // the real outcome, not just whatever's left of the original tab
      // reference. Only falls back to the plain "uncertain" notice if that
      // still comes up with no real reply text either.
      if (conversationIdAtQueueTime && tab.conversationId !== conversationIdAtQueueTime) {
        const resolved = await this.tryResolveSwitchedDuringSend(conversationIdAtQueueTime, lang);
        return resolved ?? this.t('conversationSwitchedDuringSend', lang);
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
        // Keep checkForDesktopActivity's baseline in sync so it doesn't
        // re-report the turn this call itself just produced.
        this.data.lastSeenMessageCount = tab.state.messages.length;
        this.data.lastSeenConversationId = tab.conversationId;
        await this.saveData(this.data);
      }

      // `/compact` (and rewind) can *replace* tab.state.messages with a
      // shorter array instead of appending to it - see the shrink comment in
      // checkForDesktopActivity for the same phenomenon on the /listen path.
      // Slicing from the pre-send `beforeCount` against a now-shorter array
      // silently yields [] (JS slice doesn't error on an out-of-range
      // start), which would skip right past the context_compacted boundary
      // block and fall into the generic "no text" reply instead of the
      // intended "compacted successfully" one. If it shrank, we can't know
      // which of the remaining messages are "new" either, so just take the
      // whole (now-short) array - for a /compact turn that's exactly the
      // compact-boundary message we need extractDispatchText to see.
      const newMessages = tab.state.messages.length >= beforeCount
        ? tab.state.messages.slice(beforeCount)
        : tab.state.messages;
      const { text: reply, compacted } = this.extractDispatchText(newMessages, lang);
      // See the matching comment in checkForDesktopActivity: right after a
      // /compact, Claudian's conversation-meta usage numbers can still be the
      // pre-compact ones, so skip the context-window line rather than show a
      // stale/misleading size next to a "compaction succeeded" message.
      const ctxLine = compacted ? null : await this.contextWindowLine(tab.conversationId, lang);
      const body = ctxLine ? `${reply}\n\n${ctxLine}` : reply;

      if (progressive && pushedAnything) {
        // Every chunk (including the context-window line, appended to the
        // last one by flushProgressive) already went out individually as the
        // turn ran - repeating any of it here would duplicate everything the
        // user just saw arrive piece by piece.
        return '';
      }

      if (stillCurrent) return body;

      // The user switched to a different conversation (or started a new one)
      // while this turn was still running. The reply is still delivered -
      // dropping it would silently lose a turn that Claudian actually ran -
      // but tagged with which conversation and prompt it belongs to, since
      // by the time it arrives it's no longer obvious from context.
      const metas = await this.readAllConversationMeta();
      const title = this.titleFor(tab.conversationId, metas);
      return this.t('switchedAwayTag', lang, title, text, body);
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
  /**
   * A message's content blocks, or - for providers/messages that never
   * populate `contentBlocks` - its plain `content` wrapped as a single
   * synthetic text block. Shared by flushProgressive() and
   * extractDispatchText(), which both need to walk "whatever blocks this
   * message actually has" and previously each reimplemented this same
   * fallback slightly differently.
   */
  private blocksOf(msg: ClaudianChatMessage): ContentBlock[] {
    if (msg.contentBlocks && msg.contentBlocks.length > 0) return msg.contentBlocks;
    return msg.content.trim() ? [{ type: 'text', content: msg.content }] : [];
  }

  private flushProgressive(tab: ClaudianTab, beforeCount: number, final: boolean, appendSuffix?: string): boolean {
    const cursor = this.progressiveCursors.get(tab.id);
    if (!cursor) return false;
    const messages = tab.state.messages.slice(beforeCount);
    // Collected locally first (not pushed to pendingPushes immediately) so
    // `appendSuffix` (the context-window line, on the final call) can be
    // glued onto the very last chunk instead of going out as its own
    // separate WeChat message.
    const chunksThisCall: string[] = [];

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
      const blocks = this.blocksOf(msg);
      const settledCount = (isLastMessage && !final) ? Math.max(0, blocks.length - 1) : blocks.length;

      for (let bi = cursor.pushedBlocksInCurrent; bi < settledCount; bi++) {
        const block = blocks[bi];
        if (block.type === 'text') {
          const trimmed = block.content.trim();
          if (trimmed) chunksThisCall.push(`${tag}${trimmed}`);
        }
        cursor.pushedBlocksInCurrent = bi + 1;
      }

      if (isLastMessage && !final) break; // still the active message; may grow more blocks next tick
      cursor.pushedMessageCount = mi + 1;
      cursor.pushedBlocksInCurrent = 0;
    }

    if (appendSuffix) {
      if (chunksThisCall.length > 0) {
        chunksThisCall[chunksThisCall.length - 1] += `\n\n${appendSuffix}`;
      } else {
        // Nothing new to attach it to this call (e.g. the turn ended on a
        // tool call with no trailing narrative text) - send it on its own
        // rather than lose it.
        chunksThisCall.push(appendSuffix);
      }
    }

    if (chunksThisCall.length > 0) {
      this.pendingPushes.push(...chunksThisCall);
      cursor.everPushed = true;
    }
    return cursor.everPushed;
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
  private extractDispatchText(messages: ClaudianChatMessage[], lang: Lang): { text: string; compacted: boolean; empty: boolean } {
    const parts: string[] = [];
    let sawCompactBoundary = false;
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      for (const block of this.blocksOf(msg)) {
        if (block.type === 'context_compacted') {
          sawCompactBoundary = true;
          continue;
        }
        if (block.type !== 'text') continue;
        const trimmed = block.content.trim();
        if (trimmed) parts.push(trimmed);
      }
    }
    if (parts.length > 0) return { text: parts.join('\n\n'), compacted: sawCompactBoundary, empty: false };
    // /compact (and equivalents on other providers) legitimately produce no
    // narrative text on success - the only sign it happened is a
    // context_compacted boundary block. Without this check that success case
    // was indistinguishable from a genuinely empty/errored turn, and got the
    // scary "did this fail?" message below even though nothing went wrong.
    if (sawCompactBoundary) return { text: this.t('compactedNoText', lang), compacted: true, empty: false };
    // `empty: true` here (as opposed to non-progressive replies, which just
    // surface this text directly) also lets the progressive path
    // (sendChatMessage's finally block) tell "the turn genuinely produced
    // nothing" apart from "nothing new since the last progressive tick" -
    // see the comment there for why that distinction matters.
    return { text: this.t('noDispatchText', lang), compacted: false, empty: true };
  }

  // ---- outbound files/images: /files, /getfile, /send ----

  /**
   * Scans `messages` (normally just the most recent turn) for files
   * Claudian's own reply either linked to or actually touched via a tool
   * call, deduplicated by resolved absolute path. Two independent sources,
   * combined:
   *
   *  - Wikilinks/embeds (`[[x]]`, `![[x]]`) in narrative text - the same
   *    syntax Claudian's own renderer turns into a clickable "jump to this
   *    file" link, resolved the same way it does (Obsidian's public
   *    `metadataCache.getFirstLinkpathDest`).
   *  - `toolCalls[].input` on assistant messages (Write/Edit/Read/
   *    NotebookEdit and equivalents) - often the *only* signal for a file
   *    Claude actually generated, since a turn frequently never bothers to
   *    link back to a file it just wrote.
   *
   * Deliberately does not check the filesystem here (existence, size) -
   * that happens once, lazily, only for whichever candidate is actually
   * picked via /getfile (queueFileForSend) - so building this list never
   * does more I/O than a user ends up asking for.
   */
  private extractReferencedFiles(messages: ClaudianChatMessage[]): { display: string; absolutePath: string }[] {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return [];
    const base = adapter.getBasePath();

    const seen = new Set<string>();
    const results: { display: string; absolutePath: string }[] = [];
    const add = (absolutePath: string) => {
      if (seen.has(absolutePath)) return;
      seen.add(absolutePath);
      results.push({ display: path.relative(base, absolutePath) || path.basename(absolutePath), absolutePath });
    };

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;

      for (const block of msg.contentBlocks ?? []) {
        if (block.type !== 'text') continue;
        WIKILINK_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = WIKILINK_RE.exec(block.content))) {
          const linkpath = match[1].split(/[#^]/)[0].trim();
          if (!linkpath) continue;
          const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, '');
          if (dest) add(path.resolve(base, dest.path));
        }
      }

      for (const call of msg.toolCalls ?? []) {
        const input = call.input;
        if (!input || typeof input !== 'object') continue;
        for (const key of TOOL_INPUT_PATH_KEYS) {
          const value = input[key];
          if (typeof value === 'string' && value.trim()) {
            add(path.isAbsolute(value) ? value : path.resolve(base, value));
          }
        }
      }
    }
    return results;
  }

  /** `/files`: lists the files extractReferencedFiles() finds in the current tab's most recent completed turn. */
  private async listReferencedFiles(lang: Lang): Promise<string> {
    const tab = await this.getOrCreateWeChatTab();
    const messages = tab.state.messages;
    const userIndices = this.getUserMessageIndices(messages);
    if (userIndices.length === 0) return this.t('histEmpty', lang);

    const lastTurn = messages.slice(userIndices[userIndices.length - 1] + 1);
    const candidates = this.extractReferencedFiles(lastTurn);
    this.lastReferencedFiles = candidates;
    if (candidates.length === 0) return this.t('filesNone', lang);

    const lines: string[] = [this.t('filesHeader', lang)];
    candidates.forEach((c, i) => lines.push(`${i + 1}. ${c.display}`));
    lines.push(this.t('getfileUsage', lang));
    return lines.join('\n');
  }

  /** `/getfile <n[,n...]>`: queues one or more files from the last /files list. */
  private async handleGetFileCommand(text: string, lang: Lang): Promise<string> {
    const rest = text.replace(/^\/getfile\s*/i, '').trim();
    if (!rest) return this.t('getfileUsage', lang);
    if (this.lastReferencedFiles.length === 0) return this.t('getfileNeedsListFirst', lang);

    const indices = rest.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
    if (indices.length === 0) return this.t('getfileUsage', lang);

    const results: string[] = [];
    for (const idx of indices) {
      const item = this.lastReferencedFiles[idx - 1];
      results.push(
        item
          ? await this.queueFileForSend(item.absolutePath, lang)
          : this.t('outOfRange', lang, this.lastReferencedFiles.length),
      );
    }
    return results.join('\n');
  }

  /** `/send <path>`: queues one explicit vault-relative path, no /files list involved. */
  private async handleSendCommand(relativePath: string, lang: Lang): Promise<string> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error(this.t('noTabManager', lang));
    const base = adapter.getBasePath();
    const resolved = path.resolve(base, relativePath);
    const normalizedBase = path.resolve(base);
    if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + path.sep)) {
      return this.t('pathOutsideVault', lang, relativePath);
    }
    return this.queueFileForSend(resolved, lang);
  }

  // ---- /schedule: local reminders pushed straight to WeChat, no Claudian turn involved ----

  /**
   * `/schedule` dispatcher. Recognized forms:
   *   /schedule list
   *   /schedule cancel <n>                     - n is the 1-based index from /schedule list
   *   /schedule daily HH:MM <text>              - recurring, fires every day at HH:MM local time
   *   /schedule HH:MM <text>                    - one-shot, next HH:MM (today if not passed yet, else tomorrow)
   *   /schedule YYYY-MM-DD HH:MM <text>          - one-shot, a specific date/time
   */
  private async handleScheduleCommand(rest: string, lang: Lang): Promise<string> {
    if (/^list\b/i.test(rest)) return this.listScheduledSends(lang);

    const cancelMatch = rest.match(/^cancel\s+(\d+)\b/i);
    if (cancelMatch) return this.cancelScheduledSend(Number(cancelMatch[1]), lang);

    const dailyMatch = rest.match(/^daily\s+(\d{1,2}):(\d{2})\s+(\S.*)$/i);
    if (dailyMatch) {
      const hour = Number(dailyMatch[1]);
      const minute = Number(dailyMatch[2]);
      const text = dailyMatch[3].trim();
      if (hour > 23 || minute > 59) return this.t('scheduleBadTime', lang);
      const nextFireAt = this.nextDailyFireAt(hour, minute);
      return this.addScheduledSend({ id: this.newScheduleId(), text, nextFireAt, repeat: { type: 'daily', hour, minute } }, lang);
    }

    const dateMatch = rest.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s+(\S.*)$/);
    if (dateMatch) {
      const [, dateStr, hStr, mStr, text] = dateMatch;
      const [y, mo, d] = dateStr.split('-').map(Number);
      const hour = Number(hStr);
      const minute = Number(mStr);
      if (hour > 23 || minute > 59) return this.t('scheduleBadTime', lang);
      const fireAt = new Date(y, mo - 1, d, hour, minute, 0, 0).getTime();
      if (!Number.isFinite(fireAt) || fireAt <= Date.now()) return this.t('scheduleInPast', lang);
      return this.addScheduledSend({ id: this.newScheduleId(), text: text.trim(), nextFireAt: fireAt, repeat: null }, lang);
    }

    const onceMatch = rest.match(/^(\d{1,2}):(\d{2})\s+(\S.*)$/);
    if (onceMatch) {
      const hour = Number(onceMatch[1]);
      const minute = Number(onceMatch[2]);
      const text = onceMatch[3].trim();
      if (hour > 23 || minute > 59) return this.t('scheduleBadTime', lang);
      return this.addScheduledSend({ id: this.newScheduleId(), text, nextFireAt: this.nextDailyFireAt(hour, minute), repeat: null }, lang);
    }

    return this.t('scheduleUsage', lang);
  }

  /** Next occurrence of HH:MM local time - today if it hasn't passed yet this tick, otherwise tomorrow. */
  private nextDailyFireAt(hour: number, minute: number): number {
    const now = new Date();
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }

  private newScheduleId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  private async addScheduledSend(entry: ScheduledSend, lang: Lang): Promise<string> {
    this.data.scheduledSends.push(entry);
    this.data.scheduledSends.sort((a, b) => a.nextFireAt - b.nextFireAt);
    await this.saveData(this.data);
    const when = new Date(entry.nextFireAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US');
    return this.t(entry.repeat ? 'scheduleAddedDaily' : 'scheduleAddedOnce', lang, when, entry.text);
  }

  private listScheduledSends(lang: Lang): string {
    if (this.data.scheduledSends.length === 0) return this.t('scheduleNone', lang);
    const localeTag = lang === 'zh' ? 'zh-CN' : 'en-US';
    const lines: string[] = [this.t('scheduleListHeader', lang)];
    this.data.scheduledSends.forEach((s, i) => {
      const when = new Date(s.nextFireAt).toLocaleString(localeTag);
      const tag = s.repeat ? this.t('scheduleDailyTag', lang) : '';
      lines.push(`${i + 1}. [${when}]${tag} ${s.text}`);
    });
    return lines.join('\n');
  }

  private async cancelScheduledSend(index: number, lang: Lang): Promise<string> {
    const entry = this.data.scheduledSends[index - 1];
    if (!entry) return this.t('outOfRange', lang, this.data.scheduledSends.length);
    this.data.scheduledSends = this.data.scheduledSends.filter((s) => s.id !== entry.id);
    await this.saveData(this.data);
    return this.t('scheduleCancelled', lang, entry.text);
  }

  private classifyFileCategory(fileName: string): PendingFileItem['category'] {
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    if (IMAGE_EXTENSIONS.has(ext)) return 'image';
    if (VIDEO_EXTENSIONS.has(ext)) return 'video';
    return 'file';
  }

  /** Shared by /send and /getfile: validates a resolved absolute path exists and isn't too large, then queues it. */
  private async queueFileForSend(absolutePath: string, lang: Lang): Promise<string> {
    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      return this.t('fileNotFound', lang, absolutePath);
    }
    if (!stat.isFile()) return this.t('fileNotFound', lang, absolutePath);
    const fileName = path.basename(absolutePath);
    if (stat.size > FILE_SEND_MAX_BYTES) {
      return this.t('fileTooLarge', lang, fileName, Math.round(stat.size / (1024 * 1024)));
    }
    this.pendingFiles.push({ absolutePath, fileName, category: this.classifyFileCategory(fileName) });
    return this.t('queuedForSend', lang, fileName);
  }

  /**
   * Serializes against getTabMutex - see that field's doc comment for why.
   * Chains onto the tail regardless of whether the previous call threw, and
   * always returns/propagates its *own* result independent of that tail
   * (same settle-agnostic-tail pattern as sendQueues in sendChatMessageQueued).
   */
  private async getOrCreateWeChatTab(): Promise<ClaudianTab> {
    const previous = this.getTabMutex.catch(() => {});
    const run = previous.then(() => this.resolveOrCreateTab(this.data.conversationId));
    this.getTabMutex = run.catch(() => {});
    return run;
  }

  /**
   * Same mutex-serialized lookup as getOrCreateWeChatTab, but for an
   * explicit conversation id rather than this.data.conversationId - used
   * wherever a send needs to (re-)locate one *specific* conversation's tab
   * by id instead of "whichever one the bridge is currently bound to" (see
   * sendChatMessage and tryResolveSwitchedDuringSend). This is the same
   * id-based lookup /goto uses to jump to a conversation, reused here so a
   * stale/mutated tab-object reference is never trusted on its own.
   */
  private async getOrCreateTabForConversation(conversationId: string): Promise<ClaudianTab> {
    const previous = this.getTabMutex.catch(() => {});
    const run = previous.then(() => this.resolveOrCreateTab(conversationId));
    this.getTabMutex = run.catch(() => {});
    return run;
  }

  /**
   * Finds the tab already open for `conversationId` (searching every pane,
   * Claudian 2.1.0+ dual-pane included), or reopens/creates it if none is
   * open right now. Claudian persists each conversation independently of
   * which tab object happens to have it open, so reopening by id always
   * reflects that conversation's real, current state - unlike holding onto
   * a tab reference across an await, which can get silently repurposed by
   * a desktop-side "New chat"/conversation switch happening in that same
   * tab object. `conversationId === null` means "brand-new blank tab", not
   * "look one up".
   */
  private async resolveOrCreateTab(conversationId: string | null): Promise<ClaudianTab> {
    const claudian = this.getClaudianPlugin();
    const view = (claudian.getAllViews?.() ?? [])[0] ?? this.findClaudianViewViaWorkspace();
    if (!view) throw new Error(this.t('noViewOpen', this.getLangSafe()));

    const tabManager = view.getTabManager?.();
    if (!tabManager) throw new Error(this.t('noTabManager', this.getLangSafe()));

    if (conversationId) {
      // Dual-pane (Claudian 2.1.0+) can open more than one view (one per
      // pane), each with its own tab manager - the bound conversation's tab
      // may live in a pane other than the first one. Search across every
      // view via Claudian's own findConversationAcrossViews when available;
      // only fall back to the single-view lookup below on older builds that
      // predate dual-pane (and thus never have more than one view anyway).
      const found = claudian.findConversationAcrossViews?.(conversationId);
      const foundTabManager = found ? found.view.getTabManager?.() : null;
      const existing = foundTabManager?.getTab?.(found!.tabId)
        ?? tabManager.getAllTabs().find((t) => t.conversationId === conversationId);
      if (existing) {
        this.installInteractiveHooks(existing);
        return existing;
      }
      // Tab was closed or conversation was never opened in a tab yet; (re)open it.
      await this.ensureTabCapacity(claudian, tabManager);
      const tab = await tabManager.createTab(conversationId);
      if (!tab) throw new Error(this.t('tabLimitReached', this.getLangSafe()));
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
    if (!tab) throw new Error(this.t('tabLimitReached', this.getLangSafe()));
    this.installInteractiveHooks(tab);
    return tab;
  }

  /**
   * Replaces this tab's inputController.handleAskUserQuestion /
   * handleApprovalRequest with headless versions that push a WeChat
   * notification and resolve from /answer or /approve, instead of rendering
   * Claudian's inline DOM widgets (OA / the approval-inline widget) that
   * nobody is looking at for a bridge-driven tab.
   *
   * Re-patches (rather than a one-time idempotent no-op) on every call whose
   * `__wechatBridgeOwner` isn't *this* plugin instance. That matters because
   * `ic` (Claudian's own inputController) outlives a wechat-bridge plugin
   * reload - Claudian itself doesn't reload with it - so after a reload the
   * marker left by the previous instance is still sitting on the same live
   * object. Without re-patching, `ic.handleAskUserQuestion` would keep
   * calling the *old* instance's handler forever: it would still resolve
   * fine, but push into the old instance's (now-disconnected) AckQueue that
   * nothing reads anymore.
   *
   * Also adopts any request that's already in flight from that old instance
   * (see the `__wechatPendingInteractive` doc comment on PendingInteractive)
   * so a question/approval that fired right before a reload doesn't strand
   * Claudian's turn forever with no way to answer it and nothing visible in
   * either UI.
   *
   * Trade-off: once installed, this tab's native desktop UI no longer shows
   * its own inline question/approval widgets either - acceptable since this
   * tab exists specifically to be driven remotely from WeChat.
   */
  private installInteractiveHooks(tab: ClaudianTab): void {
    const ic = tab.controllers.inputController as WeChatPatchedInputController | null;
    if (!ic) return;

    if (ic.__wechatPendingInteractive && ic.__wechatPendingInteractive !== this.pendingInteractive) {
      this.pendingInteractive = ic.__wechatPendingInteractive;
      const lang = this.getLangSafe();
      this.pendingPushes.push(`${this.t('reconnectedPendingPrefix', lang)}\n${ic.__wechatPendingInteractive.promptText}`);
    }

    // Capture the true native handlers exactly once, ever, the first time we
    // ever see this inputController - i.e. before it's been patched by any
    // instance. Must happen before the owner check below (which short-circuits
    // on every call after the first patch), otherwise a post-reload re-patch
    // would capture the *previous* instance's headless wrapper as "native".
    if (!ic.__wechatOriginalHandleAskUserQuestion && ic.handleAskUserQuestion) {
      ic.__wechatOriginalHandleAskUserQuestion = ic.handleAskUserQuestion.bind(ic);
      ic.__wechatOriginalHandleApprovalRequest = ic.handleApprovalRequest?.bind(ic);
    }

    if (ic.__wechatBridgeOwner === this) return;
    ic.__wechatBridgeOwner = this;
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
    const lines: string[] = [this.t('askUserQuestionHeader', lang)];
    questions.forEach((q, qi) => {
      lines.push(`\n${questions.length > 1 ? `[${qi + 1}] ` : ''}${q.question}`);
      q.options.forEach((o, oi) => lines.push(`  ${oi + 1}. ${o.label}`));
    });
    lines.push('\n' + this.t(questions.length > 1 ? 'askUserQuestionUsageMulti' : 'askUserQuestionUsageSingle', lang));
    const promptText = lines.join('\n');

    const ic = tab.controllers.inputController as WeChatPatchedInputController;
    let pending: Extract<PendingInteractive, { kind: 'question' }> | null = null;
    let settled = false;

    const wechatPromise = new Promise<Record<string, string | string[]> | null>((resolve) => {
      pending = {
        kind: 'question', tabId: tab.id, questions, selections: new Map(), promptText, sourceIc: ic,
        resolve: (value) => { settled = true; resolve(value); },
      };
      this.pendingInteractive = pending;
      ic.__wechatPendingInteractive = pending;
      this.pendingPushes.push(promptText);
    });

    // Also drive Claudian's own native inline widget in parallel: a user
    // sitting at the desktop right now should still see and be able to
    // answer the question there, instead of finding the UI apparently
    // frozen just because this tab is also WeChat-bound. Whichever side
    // answers first wins; the other is cleaned up.
    const nativeHandler = ic.__wechatOriginalHandleAskUserQuestion;
    const nativePromise: Promise<Record<string, string | string[]> | null> = nativeHandler
      ? Promise.resolve(nativeHandler(input)).then((value) => {
          if (!settled && pending) {
            settled = true;
            this.clearPendingInteractive(pending);
            this.pendingPushes.push(this.t('answeredOnDesktop', lang));
          }
          return value;
        }).catch(() => null)
      : new Promise<Record<string, string | string[]> | null>(() => {}); // no native handler available - never resolves, WeChat side is the only path

    return Promise.race([wechatPromise, nativePromise]);
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
    const promptText = this.t('approvalHeader', lang, title, desc);
    const ic = tab.controllers.inputController as WeChatPatchedInputController;
    let pending: Extract<PendingInteractive, { kind: 'approval' }> | null = null;
    let settled = false;

    const wechatPromise = new Promise<'accept' | 'acceptForSession' | 'decline' | 'cancel'>((resolve) => {
      pending = {
        kind: 'approval', tabId: tab.id, title, promptText, sourceIc: ic,
        resolve: (value) => { settled = true; resolve(value); },
      };
      this.pendingInteractive = pending;
      ic.__wechatPendingInteractive = pending;
      this.pendingPushes.push(promptText);
    });

    // See handleAskUserQuestionHeadless: also drive the native approval
    // widget in parallel so a desktop user isn't stuck looking at nothing.
    const nativeHandler = ic.__wechatOriginalHandleApprovalRequest;
    const nativePromise: Promise<'accept' | 'acceptForSession' | 'decline' | 'cancel'> = nativeHandler
      ? Promise.resolve(nativeHandler(kind, details, title, _opts)).then((value) => {
          if (!settled && pending) {
            settled = true;
            this.clearPendingInteractive(pending);
            this.pendingPushes.push(this.t('answeredOnDesktop', lang));
          }
          return value;
        }).catch(() => 'cancel' as const)
      : new Promise<'accept' | 'acceptForSession' | 'decline' | 'cancel'>(() => {});

    return Promise.race([wechatPromise, nativePromise]);
  }

  /**
   * Splits a multi-question /answer's argument text into one {qIndex,
   * selectionText} pair per question it addresses.
   *
   * Motivated by a real ClawBot report: a user meaning "question 1 -> option
   * 2, question 2 -> option 2" typed `/answer 1 2，2 2` (note the full-width
   * "，" - easy to end up with from a phone IME, and previously invisible to
   * this parser, which only split on ASCII ","). The old single-match
   * `^(\d+)\s+(.+)$` treated everything after the first number as one
   * question's freeform answer, silently swallowing the second question
   * entirely.
   *
   * Splits on any of `,` `，` `;` `；` (ASCII/full-width comma or semicolon),
   * then only starts a *new* pair when a chunk begins with `<digits><space>`
   * - a chunk that doesn't (e.g. the "3" in a multi-select answer like
   * `1 2,3`) is folded back into the previous pair's selection text instead,
   * so a single question's comma-separated option list (`/answer 1 2,3`)
   * still works exactly as before. A leading chunk that never matches (no
   * pair open yet) is dropped rather than throwing - the caller reports
   * "usage" if nothing parsed at all.
   */
  private splitAnswerPairs(rest: string): { qIndex: number; selectionText: string }[] {
    const pairs: { qIndex: number; selectionText: string }[] = [];
    for (const raw of rest.split(/[,，;；]/)) {
      const chunk = raw.trim();
      if (!chunk) continue;
      const m = chunk.match(/^(\d+)\s+(\S.*)$/);
      if (m) {
        pairs.push({ qIndex: Number(m[1]) - 1, selectionText: m[2] });
      } else if (pairs.length > 0) {
        pairs[pairs.length - 1].selectionText += `,${chunk}`;
      }
    }
    return pairs;
  }

  /** Applies one {qIndex, selectionText} pair to `pending`'s in-progress selections. Returns an error string, or null on success. */
  private applyAnswerPair(
    pending: Extract<PendingInteractive, { kind: 'question' }>,
    qIndex: number,
    selectionText: string,
    lang: Lang,
  ): string | null {
    const q = pending.questions[qIndex];
    if (!q) return this.t('outOfRange', lang, pending.questions.length);

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
    return null;
  }

  /**
   * Clears `this.pendingInteractive` and, if it's still the same request,
   * the matching `__wechatPendingInteractive` marker on its source
   * inputController too - otherwise that marker would look like an
   * orphaned-by-reload request forever and installInteractiveHooks would
   * keep re-adopting (and re-pushing to WeChat) a request that's actually
   * already been resolved.
   */
  private clearPendingInteractive(pending: PendingInteractive): void {
    if (this.pendingInteractive === pending) this.pendingInteractive = null;
    if (pending.sourceIc.__wechatPendingInteractive === pending) pending.sourceIc.__wechatPendingInteractive = undefined;
  }

  /** Handles `/answer ...`, resolving whatever handleAskUserQuestionHeadless() is currently waiting on. */
  private async handleAnswerCommand(text: string, lang: Lang): Promise<string> {
    const pending = this.pendingInteractive;
    if (!pending || pending.kind !== 'question') return this.t('noPendingQuestion', lang);

    const rest = text.replace(/^\/answer\s*/i, '').trim();
    if (/^cancel$/i.test(rest)) {
      pending.resolve(null);
      this.clearPendingInteractive(pending);
      return this.t('questionCancelled', lang);
    }
    if (!rest) return this.t('answerUsage', lang);

    if (pending.questions.length > 1) {
      // Accepts either one "N answer" pair, or several separated by a comma/
      // semicolon (ASCII or full-width) - see splitAnswerPairs() for why.
      const pairs = this.splitAnswerPairs(rest);
      if (pairs.length === 0) return this.t('answerUsageMulti', lang);
      for (const { qIndex, selectionText } of pairs) {
        const err = this.applyAnswerPair(pending, qIndex, selectionText, lang);
        if (err) return err;
      }
    } else {
      const err = this.applyAnswerPair(pending, 0, rest, lang);
      if (err) return err;
    }

    if (pending.selections.size >= pending.questions.length) {
      const result: Record<string, string | string[]> = {};
      pending.questions.forEach((qq, i) => {
        const sel = pending.selections.get(i);
        if (!sel || sel.size === 0) return;
        result[qq.key] = qq.multiSelect ? Array.from(sel) : Array.from(sel)[0];
      });
      pending.resolve(result);
      this.clearPendingInteractive(pending);
      return this.t('questionAnswered', lang);
    }
    return this.t('questionPartial', lang, pending.selections.size, pending.questions.length);
  }

  /**
   * Handles `/esc`: interrupts whichever turn(s) this bridge itself set in
   * flight (tab ids currently in sendingViaBridgeTabIds - the same guard
   * checkForDesktopActivity uses), by calling the tab's own cancelStreaming(),
   * the same call the desktop UI's Stop button/Escape key makes. Does not try
   * to synthesize or return the partial reply itself - the in-flight
   * sendChatMessage() call for that tab resolves normally once the turn
   * actually stops (same as it would on natural completion) and delivers
   * whatever text had streamed in by then through its own existing reply
   * path, including progressive chunks already pushed.
   */
  private async handleEscCommand(lang: Lang): Promise<string> {
    if (this.sendingViaBridgeTabIds.size === 0) {
      return this.t('escNothingToInterrupt', lang);
    }
    const allTabs = this.getAllTabsAcrossPanes(lang);
    let interrupted = false;
    for (const tabId of this.sendingViaBridgeTabIds) {
      const tab = allTabs.find((t) => t.id === tabId);
      if (tab?.state.isStreaming && tab.controllers.inputController?.cancelStreaming) {
        tab.controllers.inputController.cancelStreaming();
        interrupted = true;
      }
    }
    return this.t(interrupted ? 'escInterrupted' : 'escNothingToInterrupt', lang);
  }

  /**
   * Every tab, across every pane's tab manager (dual-pane, 2.1.0+) -
   * collecting only getAllViews()[0]'s tabs would silently miss a tab that's
   * genuinely open in another pane. Shared by /esc and the mid-send
   * conversation-switch auto-resolution below.
   */
  private getAllTabsAcrossPanes(lang: Lang): ClaudianTab[] {
    const views = this.getClaudianPlugin().getAllViews?.() ?? [];
    const fallbackView = views[0] ?? this.findClaudianViewViaWorkspace();
    if (views.length === 0 && !fallbackView) throw new Error(this.t('noTabManager', lang));
    const tabManagers = (views.length > 0 ? views : [fallbackView]).map((v) => v?.getTabManager?.()).filter((tm): tm is ClaudianTabManager => !!tm);
    if (tabManagers.length === 0) throw new Error(this.t('noTabManager', lang));
    return tabManagers.flatMap((tm) => tm.getAllTabs());
  }

  /**
   * Called only when a bridge-driven send finds tab.conversationId no
   * longer matches what it was sent to (the desktop switched conversations
   * in the same tab mid-send, again, even after sendChatMessage already
   * re-located the tab by id right before sending - see there). Tries to
   * automatically determine the real outcome instead of just telling the
   * user to go check manually: re-locates conversationId by id one more
   * time (the same /goto-style lookup, via getOrCreateTabForConversation -
   * not a raw pane search), which reflects that conversation's real state
   * whether or not any tab happened to still be open for it, and reads its
   * actual latest turn straight off it. Returns null - meaning "still can't
   * tell, fall back to the plain uncertain notice" - only when that lookup
   * itself fails, or the turn genuinely has no reply text yet (still
   * running, or truly failed).
   */
  private async tryResolveSwitchedDuringSend(conversationId: string, lang: Lang): Promise<string | null> {
    let originalTab: ClaudianTab;
    try {
      originalTab = await this.getOrCreateTabForConversation(conversationId);
    } catch {
      return null;
    }
    if (originalTab.state.isStreaming) return null;

    const messages = originalTab.state.messages;
    const userIndices = this.getUserMessageIndices(messages);
    if (userIndices.length === 0) return null;
    const turnMessages = messages.slice(userIndices[userIndices.length - 1] + 1);
    const { text: reply, compacted, empty } = this.extractDispatchText(turnMessages, lang);
    if (empty || !reply.trim()) return null;

    const metas = await this.readAllConversationMeta();
    const title = this.titleFor(conversationId, metas);
    const ctxLine = compacted ? null : await this.contextWindowLine(conversationId, lang);
    const body = ctxLine ? `${reply}\n\n${ctxLine}` : reply;
    return this.t('conversationSwitchedDuringSendResolved', lang, title, body);
  }

  /** Handles `/approve accept|always|deny|cancel`, resolving handleApprovalRequestHeadless(). */
  private async handleApproveCommand(text: string, lang: Lang): Promise<string> {
    const pending = this.pendingInteractive;
    if (!pending || pending.kind !== 'approval') return this.t('noPendingApproval', lang);
    const m = text.match(/^\/approve\s+(accept|always|deny|cancel)\b/i);
    if (!m) return this.t('approveUsage', lang);
    const word = m[1].toLowerCase();
    const decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' = word === 'accept' ? 'accept' : word === 'always' ? 'acceptForSession' : word === 'deny' ? 'decline' : 'cancel';
    pending.resolve(decision);
    this.clearPendingInteractive(pending);
    return this.t('approvalResolved', lang, decision);
  }

  /**
   * TabManager.createTab() silently returns `null` instead of a tab once
   * `tabs.size + pendingTabCreations >= maxTabs` (Claudian's own cap, clamped
   * 3-10 - see main.js's TabManager.createTab). If the bridge's own bound
   * conversation isn't already open as a tab (view was closed/reopened, or
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
    if (!plugin) throw new Error(this.t('pluginNotEnabled', 'en', CLAUDIAN_PLUGIN_ID));
    return plugin as ClaudianPluginInstance;
  }
}
