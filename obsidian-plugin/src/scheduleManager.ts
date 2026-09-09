import { Lang, ScheduledSend } from './bridgeTypes';

/**
 * Everything the schedule manager needs from the host plugin, kept to a
 * narrow interface instead of taking the whole plugin instance - the
 * scheduling logic itself doesn't need to know about tabs, Claudian, or
 * anything else main.ts owns.
 */
export interface ScheduleManagerDeps {
  getScheduledSends(): ScheduledSend[];
  setScheduledSends(list: ScheduledSend[]): void;
  saveData(): Promise<void>;
  t(key: string, lang: Lang, ...args: (string | number)[]): string;
  /**
   * Sends `text` into the bound conversation as if the user had typed it
   * (same queued path a real WeChat message takes - see
   * sendChatMessageQueued), and delivers whatever Claudian replies with back
   * to WeChat. A scheduled send is meant to prompt the AI in the current
   * conversation, not just parrot the reminder text back verbatim - use
   * `getLangSafe()`-equivalent for `lang` since there's no inbound request to
   * read a language from at fire time.
   */
  sendToConversation(text: string, lang: Lang): Promise<void>;
}

/**
 * Owns `/schedule` end to end: parsing the command, storing entries, and
 * firing them on their own timer tick (checkDue, called from the same
 * interval main.ts already runs for checkForDesktopActivity). Firing an
 * entry sends its text into the bound conversation as a real prompt (see
 * ScheduleManagerDeps.sendToConversation) - the same way any WeChat message
 * would - and relays Claudian's reply back to WeChat; it is not a bare
 * "echo this text back at the scheduled time" alarm. Entries themselves
 * still live in BridgeData (see ScheduledSend) so they persist across
 * reloads the same way every other piece of bridge state does; this class
 * only owns the logic that reads/writes that array, not the array's
 * storage.
 */
export class ScheduleManager {
  constructor(private readonly deps: ScheduleManagerDeps) {}

  /**
   * `/schedule` dispatcher. Recognized forms:
   *   /schedule list
   *   /schedule cancel <n>                     - n is the 1-based index from /schedule list
   *   /schedule daily HH:MM <text>              - recurring, fires every day at HH:MM local time
   *   /schedule HH:MM <text>                    - one-shot, next HH:MM (today if not passed yet, else tomorrow)
   *   /schedule YYYY-MM-DD HH:MM <text>          - one-shot, a specific date/time
   */
  async handleCommand(rest: string, lang: Lang): Promise<string> {
    if (/^list\b/i.test(rest)) return this.listScheduledSends(lang);

    const cancelMatch = rest.match(/^cancel\s+(\d+)\b/i);
    if (cancelMatch) return this.cancelScheduledSend(Number(cancelMatch[1]), lang);

    const dailyMatch = rest.match(/^daily\s+(\d{1,2}):(\d{2})\s+(\S.*)$/i);
    if (dailyMatch) {
      const hour = Number(dailyMatch[1]);
      const minute = Number(dailyMatch[2]);
      const text = dailyMatch[3].trim();
      if (hour > 23 || minute > 59) return this.deps.t('scheduleBadTime', lang);
      const nextFireAt = this.nextDailyFireAt(hour, minute);
      return this.addScheduledSend({ id: this.newScheduleId(), text, nextFireAt, repeat: { type: 'daily', hour, minute } }, lang);
    }

    const dateMatch = rest.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s+(\S.*)$/);
    if (dateMatch) {
      const [, dateStr, hStr, mStr, text] = dateMatch;
      const [y, mo, d] = dateStr.split('-').map(Number);
      const hour = Number(hStr);
      const minute = Number(mStr);
      if (hour > 23 || minute > 59) return this.deps.t('scheduleBadTime', lang);
      const fireAt = new Date(y, mo - 1, d, hour, minute, 0, 0).getTime();
      if (!Number.isFinite(fireAt) || fireAt <= Date.now()) return this.deps.t('scheduleInPast', lang);
      return this.addScheduledSend({ id: this.newScheduleId(), text: text.trim(), nextFireAt: fireAt, repeat: null }, lang);
    }

    const onceMatch = rest.match(/^(\d{1,2}):(\d{2})\s+(\S.*)$/);
    if (onceMatch) {
      const hour = Number(onceMatch[1]);
      const minute = Number(onceMatch[2]);
      const text = onceMatch[3].trim();
      if (hour > 23 || minute > 59) return this.deps.t('scheduleBadTime', lang);
      return this.addScheduledSend({ id: this.newScheduleId(), text, nextFireAt: this.nextDailyFireAt(hour, minute), repeat: null }, lang);
    }

    return this.deps.t('scheduleUsage', lang);
  }

  /**
   * Fires any entry whose nextFireAt has passed: sends its text into the
   * bound conversation (so Claudian actually acts on it, same as if the user
   * had typed it) and either removes it (one-shot) or rolls nextFireAt
   * forward by its repeat rule (recurring) so it fires again next time
   * around. Entries are sent one at a time (awaited in order) - firing
   * several at once into the same tab is exactly what sendChatMessageQueued
   * already serializes safely, but there's no reason to race them here too.
   */
  async checkDue(lang: Lang): Promise<void> {
    const scheduledSends = this.deps.getScheduledSends();
    if (scheduledSends.length === 0) return;
    const now = Date.now();
    const due = scheduledSends.filter((s) => s.nextFireAt <= now);
    if (due.length === 0) return;

    let list = scheduledSends;
    let changed = false;
    for (const entry of due) {
      await this.deps.sendToConversation(entry.text, lang);
      if (entry.repeat?.type === 'daily') {
        // Roll forward a whole number of days from the missed slot (not just
        // "+1 day from now") so a brief Obsidian outage across the fire time
        // doesn't drift the daily time of day.
        let next = entry.nextFireAt;
        while (next <= now) next += 24 * 60 * 60 * 1000;
        entry.nextFireAt = next;
      } else {
        list = list.filter((s) => s.id !== entry.id);
      }
      changed = true;
    }
    if (changed) {
      this.deps.setScheduledSends(list);
      await this.deps.saveData();
    }
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
    const list = [...this.deps.getScheduledSends(), entry].sort((a, b) => a.nextFireAt - b.nextFireAt);
    this.deps.setScheduledSends(list);
    await this.deps.saveData();
    const when = new Date(entry.nextFireAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US');
    return this.deps.t(entry.repeat ? 'scheduleAddedDaily' : 'scheduleAddedOnce', lang, when, entry.text);
  }

  private listScheduledSends(lang: Lang): string {
    const scheduledSends = this.deps.getScheduledSends();
    if (scheduledSends.length === 0) return this.deps.t('scheduleNone', lang);
    const localeTag = lang === 'zh' ? 'zh-CN' : 'en-US';
    const lines: string[] = [this.deps.t('scheduleListHeader', lang)];
    scheduledSends.forEach((s, i) => {
      const when = new Date(s.nextFireAt).toLocaleString(localeTag);
      const tag = s.repeat ? this.deps.t('scheduleDailyTag', lang) : '';
      lines.push(`${i + 1}. [${when}]${tag} ${s.text}`);
    });
    return lines.join('\n');
  }

  private async cancelScheduledSend(index: number, lang: Lang): Promise<string> {
    const scheduledSends = this.deps.getScheduledSends();
    const entry = scheduledSends[index - 1];
    if (!entry) return this.deps.t('outOfRange', lang, scheduledSends.length);
    this.deps.setScheduledSends(scheduledSends.filter((s) => s.id !== entry.id));
    await this.deps.saveData();
    return this.deps.t('scheduleCancelled', lang, entry.text);
  }
}
