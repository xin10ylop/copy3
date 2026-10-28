/**
 * Shared in-process memory between command handlers and the notifier, so the same thing is
 * never announced twice (e.g. a play proposed by a /play job is carded by the job and must not
 * be carded again when the notifier sees its `play_proposed` event).
 */
import type { KillState } from './store.js';

export class Registry {
  private readonly carded = new Set<number>();
  private readonly runs = new Set<number>();
  /** last kill-switch state announced (by /kill, /resume or the notifier) */
  kill: KillState | null = null;

  /** true if `playId` was not carded before (and marks it) */
  claimCard(playId: number): boolean {
    if (this.carded.has(playId)) return false;
    this.carded.add(playId);
    return true;
  }

  markRunReported(runId: number | null): void {
    if (runId !== null) this.runs.add(runId);
  }

  runReported(runId: unknown): boolean {
    return typeof runId === 'number' && this.runs.has(runId);
  }
}
