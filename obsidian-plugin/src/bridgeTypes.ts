// Language is decided per-request from Claudian's own `settings.locale`
// (e.g. "zh-CN", "en"), not from any setting of this plugin's own. Shared
// across main.ts and any module (e.g. scheduleManager.ts) that builds
// user-facing reply text via the same `t()` lookup.
export type Lang = 'zh' | 'en';

// Every provider Claudian ships. `claude` has no `enabled` flag in its own
// registration (ProviderRegistry: `isEnabled: () => true`) - it's always on;
// the others are opt-in and expose `providerConfigs.<id>.enabled` in
// Claudian's settings, matching each provider's own registration.ts.
export const ALL_PROVIDER_IDS = ['claude', 'codex', 'opencode', 'pi', 'grok'] as const;
export type ProviderId = (typeof ALL_PROVIDER_IDS)[number];

/** Inbound image payload as sent by relay.py's /message POST body. */
export interface IncomingImage {
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
export interface PendingFileItem {
  absolutePath: string;
  fileName: string;
  /** Picks which wechat_clawbot upload/send pair relay.py uses. */
  category: 'image' | 'video' | 'file';
}

/**
 * A /schedule entry: `text` is sent into the bound conversation as a real
 * prompt (via sendChatMessageQueued, same as any WeChat message) when it
 * comes due, and Claudian's reply is what actually reaches WeChat - see
 * ScheduleManager.checkDue. `nextFireAt` is always the next
 * (or only, for one-shot) fire time in epoch ms; `repeat` describes how to
 * recompute it after firing, or is null for a one-shot entry that gets
 * removed from `scheduledSends` once it fires.
 */
export interface ScheduledSend {
  id: string;
  text: string;
  nextFireAt: number;
  repeat: null | { type: 'daily'; hour: number; minute: number };
}

export interface BridgeData {
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

export const DEFAULT_DATA: BridgeData = {
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
