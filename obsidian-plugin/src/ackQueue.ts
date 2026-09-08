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
export class AckQueue<T> {
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
