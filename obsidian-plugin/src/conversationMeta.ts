import { App, FileSystemAdapter } from 'obsidian';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ConversationMeta, conversationSortKey } from './claudianTypes';

/**
 * Reads and caches every conversation's meta.json from
 * `.claudian/sessions/` - the read-only listing source behind /ls, /switch,
 * /status, and every other command that needs a conversation's title,
 * provider, or usage numbers. Split out of main.ts since this logic is
 * entirely self-contained (disk I/O + an in-memory cache, no Claudian
 * runtime objects or tab state involved).
 */
export class ConversationMetaStore {
  private cache: { at: number; metas: ConversationMeta[] } | null = null;
  private static readonly CACHE_TTL_MS = 5000;

  constructor(private readonly app: App) {}

  /** Drops the cache so the next readAll() re-scans disk - used right after a turn completes, to report that turn's fresh usage numbers instead of a pre-turn snapshot. */
  invalidate(): void {
    this.cache = null;
  }

  /** Whatever readAll() last cached, without triggering a fresh read - best-effort for callers (e.g. a setInterval tick) that can't await a disk read. */
  peekCached(): ConversationMeta[] | null {
    return this.cache?.metas ?? null;
  }

  private getSessionsDir(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('Vault is not on a local filesystem.');
    }
    return path.join(adapter.getBasePath(), '.claudian', 'sessions');
  }

  /**
   * Reads every non-tombstoned `<id>.meta.json` file directly inside `dir`
   * (non-recursive). Missing dir -> []. A `<id>.deleted.json` sibling in the
   * same directory excludes that id from the result (see readAll's doc
   * comment).
   */
  private async readMetaFilesIn(dir: string): Promise<ConversationMeta[]> {
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      return [];
    }
    const deletedIds = new Set(
      files.filter((f) => f.endsWith('.deleted.json')).map((f) => f.slice(0, -'.deleted.json'.length)),
    );
    const metaFiles = files.filter((f) => f.endsWith('.meta.json'));
    const metas: ConversationMeta[] = [];
    for (const file of metaFiles) {
      const id = file.slice(0, -'.meta.json'.length);
      if (deletedIds.has(id)) continue;
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf-8');
        metas.push(JSON.parse(raw));
      } catch {
        // skip unreadable/corrupt meta file
      }
    }
    return metas;
  }

  /**
   * Reads every `<id>.meta.json` under `.claudian/sessions/` asynchronously
   * (fs/promises), so a large, ever-growing session history never blocks
   * Obsidian's renderer thread the way synchronous fs calls would.
   *
   * Layout and tombstone convention reverse-engineered from Claudian's own
   * `SessionMetadataStore` (its own `.scan()`/`.listAllConversations()`),
   * which this deliberately mirrors instead of guessing at a simpler shape -
   * it applies equally to every provider (`providerId` is just a field on
   * the same meta.json, not something that changes where/how a conversation
   * is stored):
   * - Most conversations live directly under `sessions/<id>.meta.json`
   *   ("unscoped").
   * - Conversations synced from another device instead (or additionally)
   *   live under `sessions/devices/<device-key>/<id>.meta.json` - one
   *   subfolder per device key, sibling to the flat files. Missing this
   *   subfolder previously made /ls silently skip every conversation stored
   *   there, regardless of provider (it wasn't provider-specific - the
   *   whole subfolder was never scanned).
   * - A conversation the user deleted isn't necessarily removed from disk -
   *   Claudian instead (or additionally) writes a `<id>.deleted.json`
   *   tombstone next to the metadata file (same directory), so deletions
   *   propagate across synced devices. Any id with such a tombstone in a
   *   given directory must be excluded from that directory's results, or
   *   /ls would resurrect conversations the user already deleted.
   * - Claudian also arbitrates between multiple copies of the same id via
   *   `<id>.assigned.json` ownership markers, and falls back to a legacy
   *   `.claude/sessions/` path - both intentionally not replicated here:
   *   this is a read-only listing feature, not the authoritative session
   *   store, so on the rare id present in more than one place, picking
   *   whichever copy is read first is an acceptable simplification.
   *
   * Result is cached in memory for `CACHE_TTL_MS`: within that window,
   * repeat callers (e.g. /switch reading the title right after /list already
   * scanned the same directory, or the /listen poller looking up a title on
   * every push) reuse the same read instead of re-scanning disk.
   */
  async readAll(): Promise<ConversationMeta[]> {
    if (this.cache && Date.now() - this.cache.at < ConversationMetaStore.CACHE_TTL_MS) {
      return this.cache.metas;
    }

    const dir = this.getSessionsDir();
    const topLevel = await this.readMetaFilesIn(dir);

    const devicesDir = path.join(dir, 'devices');
    let deviceKeys: string[];
    try {
      deviceKeys = await fs.readdir(devicesDir);
    } catch {
      deviceKeys = [];
    }
    const perDevice = await Promise.all(
      deviceKeys.map((key) => this.readMetaFilesIn(path.join(devicesDir, key))),
    );

    // Dedupe by id for the rare conversation present in more than one
    // location (see class doc comment) - unscoped copy wins over any
    // device-scoped copy, since that's the one Claudian's own UI reads by
    // default absent an active device assignment.
    const seen = new Set<string>();
    const metas: ConversationMeta[] = [];
    for (const m of [...topLevel, ...perDevice.flat()]) {
      if (!m?.id || seen.has(m.id)) continue;
      seen.add(m.id);
      metas.push(m);
    }

    // Same field, same fallback, for every provider - lastActivityAt is
    // what Claudian's own listAllConversations() sorts by; createdAt/0 are
    // just this bridge's extra defensiveness against an unfamiliar/older
    // meta.json shape missing that field (see conversationSortKey).
    metas.sort((a, b) => conversationSortKey(b) - conversationSortKey(a));
    this.cache = { at: Date.now(), metas };
    return metas;
  }
}
