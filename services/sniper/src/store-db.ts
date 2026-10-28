/** Postgres-backed store. The ONLY file that imports the @hood/db stub (swap the import below). */
import type { ArmedCandidate, Play } from '@hood/core';
import * as db from './stubs/db.js'; // STUB → replace with '@hood/db' once packages/db exports these
import type { ChangeChannel, EventRecord, FeedBlockRow, SnipeRecord, SnipeStats, SniperStore } from './store.js';

export class PgStore implements SniperStore {
  private readonly sql: db.Sql;

  constructor(url: string) {
    this.sql = db.createDb(url);
  }

  loadPlays(): Promise<Play[]> {
    return db.listEnabledPlays(this.sql);
  }
  loadArmed(): Promise<ArmedCandidate[]> {
    return db.listArmed(this.sql);
  }
  loadSettings(): Promise<Record<string, unknown>> {
    return db.getSettings(this.sql);
  }
  loadSnipeStats(since: Date): Promise<SnipeStats> {
    return db.snipeStats(this.sql, since);
  }
  async onChange(cb: (channel: ChangeChannel, payload: string) => void): Promise<() => Promise<void>> {
    const channels: ChangeChannel[] = ['plays_changed', 'armed_changed', 'settings_changed'];
    const subs = await Promise.all(channels.map((c) => db.listen(this.sql, c, (p) => cb(c, p))));
    return async () => {
      await Promise.all(subs.map((s) => s.unlisten()));
    };
  }
  insertSnipe(s: SnipeRecord): Promise<number> {
    return db.insertSnipe(this.sql, s);
  }
  updateSnipe(id: number, patch: Partial<SnipeRecord>): Promise<void> {
    return db.updateSnipe(this.sql, id, patch);
  }
  insertEvent(e: EventRecord): Promise<void> {
    return db.insertEvent(this.sql, e);
  }
  notifySnipeEvent(payload: string): Promise<void> {
    return db.notify(this.sql, 'snipe_events', payload);
  }
  insertFeedBlocks(rows: FeedBlockRow[]): Promise<void> {
    return db.insertFeedBlocks(this.sql, rows);
  }
  async close(): Promise<void> {
    await this.sql.end({ timeout: 2 });
  }
}
