/**
 * Background jobs for the slow commands (/play, /scout, /backtest can run for minutes and cost
 * money). Handlers reply immediately and submit a job; the runner bounds concurrency, refuses
 * duplicates (same coin twice) and reports through the job's callbacks. Never blocks updates.
 */
import type { Logger } from 'pino';

export type JobKind = 'play' | 'scout' | 'backtest';

export interface JobSpec<T> {
  kind: JobKind;
  /** dedupe key, e.g. `play:0xabc…` */
  key: string;
  label: string;
  run: () => Promise<T>;
  onDone: (result: T, durationSec: number) => Promise<void>;
  onError: (error: unknown, durationSec: number) => Promise<void>;
}

export type SubmitResult = { ok: true; id: number; queuedBehind: number } | { ok: false; error: string };

interface Entry {
  id: number;
  spec: JobSpec<unknown>;
}

export class JobRunner {
  private nextId = 1;
  private readonly queue: Entry[] = [];
  private readonly running = new Map<number, Entry>();
  private waiters: Array<() => void> = [];

  constructor(
    private readonly opts: { concurrency: number; maxQueue: number; log: Pick<Logger, 'info' | 'error'> },
    private readonly clock: () => number = () => Date.now(),
  ) {}

  submit<T>(spec: JobSpec<T>): SubmitResult {
    const dup = [...this.running.values(), ...this.queue].find((e) => e.spec.key === spec.key);
    if (dup) return { ok: false, error: `already running: ${dup.spec.label} (job ${dup.id})` };
    if (this.queue.length >= this.opts.maxQueue) return { ok: false, error: `queue full (${this.opts.maxQueue} waiting), try again later` };
    const entry: Entry = { id: this.nextId++, spec: spec as JobSpec<unknown> };
    const queuedBehind = this.running.size >= this.opts.concurrency ? this.queue.length + 1 : 0;
    this.queue.push(entry);
    this.pump();
    return { ok: true, id: entry.id, queuedBehind };
  }

  /** kinds currently executing (the notifier suppresses duplicate "run finished" events for them) */
  activeKinds(): Set<JobKind> {
    return new Set([...this.running.values()].map((e) => e.spec.kind));
  }

  get size(): number {
    return this.queue.length + this.running.size;
  }

  /** resolves once nothing is queued or running (tests, graceful shutdown) */
  idle(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private pump(): void {
    while (this.running.size < this.opts.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.running.set(entry.id, entry);
      void this.execute(entry);
    }
    if (this.size === 0) {
      const w = this.waiters;
      this.waiters = [];
      w.forEach((f) => f());
    }
  }

  private async execute(entry: Entry): Promise<void> {
    const started = this.clock();
    const dur = (): number => (this.clock() - started) / 1000;
    this.opts.log.info({ job: entry.id, kind: entry.spec.kind, label: entry.spec.label }, 'job started');
    try {
      const result = await entry.spec.run();
      await entry.spec.onDone(result, dur()).catch((e: unknown) => this.opts.log.error({ err: e, job: entry.id }, 'job onDone failed'));
    } catch (err) {
      this.opts.log.error({ err, job: entry.id, kind: entry.spec.kind }, 'job failed');
      await entry.spec.onError(err, dur()).catch((e: unknown) => this.opts.log.error({ err: e, job: entry.id }, 'job onError failed'));
    } finally {
      this.running.delete(entry.id);
      this.pump();
    }
  }
}
