// ---- Minimal shape of the parts of Claudian we reach into at runtime. ----
// These are not Claudian's declared public API; they are the same fields/
// methods Claudian's own UI code uses internally (verified against source).

export type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolId: string }
  | { type: 'thinking'; content: string; durationSeconds?: number }
  | { type: 'subagent'; subagentId: string }
  | { type: 'context_compacted' };

export interface ClaudianChatMessage {
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

export interface ClaudianSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** Shape Claudian's own paste/drop image-attachment code builds (ImageContextManager.addImageFromFile) -
 * `sendMessage`'s `images` option is a plain array of these, verified against the same call site
 * (`this.sendMessage({content, images, turnRequestOverride})`) that the queued-message replay path uses. */
export interface ClaudianImageAttachment {
  id: string;
  name: string;
  mediaType: string;
  data: string; // base64, no "data:" prefix
  size: number;
  source: string;
}

export interface ClaudianTab {
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

export interface ClaudianTabManager {
  getAllTabs(): ClaudianTab[];
  getTab?(tabId: string): ClaudianTab | null;
  /**
   * Verified against Claudian's real implementation: the only options it
   * recognizes are `activate`, `lifecycleState`, and `draftModel` - there is
   * no per-call "use this provider" option. A brand-new blank tab's
   * provider/model comes from the *global* `settings.settingsProvider`
   * field instead (resolveBlankTabModel reads that, not anything passed
   * here) - see switchProvider in main.ts, which sets it via
   * mutateSettings() before creating a new tab.
   */
  createTab(conversationId?: string, tabId?: string, options?: { activate?: boolean; lifecycleState?: string; draftModel?: string }): Promise<ClaudianTab>;
  getSdkCommands(tabId?: string): Promise<ClaudianSlashCommand[]>;
}

export interface ClaudianView {
  getTabManager?(): ClaudianTabManager | null;
  refreshModelSelector?(): void;
}

export interface ClaudianPluginInstance {
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
  /**
   * Claudian's own "get a view, opening/focusing its leaf if none exists
   * yet" helper (`this.getView() || (await this.activateView(), this.getView())`
   * in Claudian's main.js) - `getAllViews()` only ever returns views for
   * leaves *currently attached to the workspace*, so if the user has closed
   * the Claudian panel entirely (not just switched away from its tab), every
   * view-dependent bridge command used to throw noViewOpen instead of
   * working, even though Claudian itself was still running fine in the
   * background. Calling this (instead of just throwing) is what lets /goto,
   * a plain chat message, etc. keep working from WeChat with the panel
   * closed, exactly the way Claudian's own ribbon icon/"Open chat view"
   * command would recover it.
   */
  ensureViewOpen?(): Promise<ClaudianView | null>;
}

/** One question from an AskUserQuestion tool_use, normalized from the raw
 * `{question, id?, header?, options, multiSelect?}` shape (reverse-engineered
 * from Claudian's OA inline-question widget's own parseQuestions()). */
export interface ParsedQuestion {
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
export type WeChatPatchedInputController = NonNullable<ClaudianTab['controllers']['inputController']> & {
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

export type PendingInteractive =
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

export interface ConversationMeta {
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

export function conversationSortKey(m: ConversationMeta): number {
  return m.lastActivityAt ?? m.createdAt ?? 0;
}
