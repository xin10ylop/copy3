/**
 * SequencerClock — where, in *local* time, does the sequencer's clock tick to a new second?
 * (docs/ARCHITECTURE.md §3, SPEC §1).
 *
 * Inputs are `(blockTimestamp, arrivalMs)` pairs from the feed. Robinhood Chain seals a
 * block every ~100 ms on a grid that is phase-locked within the second; the first block
 * with timestamp S is sealed shortly after the sequencer's S-second tick and reaches us
 * `feed latency` later. For every new second we keep the earliest arrival and its offset
 * `arrival − S·1000`. The lower envelope (rolling min over ~120 s, with linear drift
 * compensation) is the *boundary offset*: `predictBoundaryMs(S) = S·1000 + offset` is the
 * local time at which the first block of second S is delivered at minimum latency.
 *
 * To be first in that block a tx must already be in the sequencer queue when it seals, i.e.
 * arrive after the previous seal (≈ one block = 100 ms earlier). Send time ≈ boundary − RTT
 * (feed one-way + send one-way) + `burst.startMs`; with the default `startMs = −120` the burst
 * starts one block + 20 ms ahead of the predicted first seal and continues past it.
 *
 * Extra estimates (for metrics and tuning): block-grid phase (circular median of
 * `arrival mod blockMs`), the latest-arrival lower bound from the last block of the previous
 * second, a jitter estimate, the within-second arrival profile, and recent per-second offsets.
 */

/** Monotonic high-resolution wall clock in ms (use the same clock for ingest and scheduling). */
export function nowMs(): number {
  return performance.timeOrigin + performance.now();
}

export interface BurstConfig {
  /** First send relative to (predicted boundary − rtt), ms. Negative = before. */
  startMs: number;
  spacingMs: number;
  count: number;
}

export interface SequencerClockOptions {
  /** Rolling window for all estimates. Default 120 000 ms. */
  windowMs?: number;
  /** Seal grid period. Default 100 ms. */
  blockMs?: number;
  /** Seconds observed before estimates are trusted. Default 5. */
  minSeconds?: number;
  /** Offset used before the clock is ready. Default 60 ms. */
  fallbackOffsetMs?: number;
  /** Fit and remove linear drift between local and sequencer clocks. Default true. */
  driftCompensation?: boolean;
  /** Only apply a fitted drift above this magnitude (ppm). Default 50. */
  minDriftPpm?: number;
  /** Clamp for the fitted drift (ppm). Default 500. */
  maxDriftPpm?: number;
  /** Minimum observed span before drift is fitted. Default 60 000 ms. */
  minDriftSpanMs?: number;
  /** Arrivals closer than this to the previous one are backlog bursts (excluded from phase). */
  backlogGapMs?: number;
  /** How many recent seconds to keep for `snapshot().recentSeconds`. Default 20. */
  historySeconds?: number;
}

export interface SecondRecord {
  ts: number;
  /** Earliest arrival of a block with this timestamp. */
  firstArrivalMs: number;
  /** firstArrivalMs − ts·1000. */
  offsetMs: number;
  /** Last arrival of the previous second minus ts·1000 (a lower bound), when contiguous. */
  lowerOffsetMs: number | undefined;
  /** Arrivals of this second's blocks relative to the first one (ms). */
  relArrivalsMs: number[];
}

export interface ClockSnapshot {
  ready: boolean;
  seconds: number;
  offsetMs: number | null;
  lowerBoundOffsetMs: number | null;
  jitterMs: number | null;
  driftPpm: number;
  phaseMs: number | null;
  /** Median arrival of the k-th block of a second relative to the first one. */
  withinSecondProfileMs: number[];
  recentSeconds: SecondRecord[];
}

export interface BurstPlan {
  /** Absolute local send times (ms), ascending. Empty ⇒ too late. */
  times: number[];
  boundaryMs: number;
  /** Last allowed send (boundary(T+2) − rtt). */
  latestMs: number;
  /** Planned members dropped because their time had already passed (replaced by one immediate send). */
  droppedPast: number;
  /** Planned members dropped by the latest-send clip. */
  clipped: number;
}

const median = (xs: number[]): number => {
  const a = [...xs].sort((x, y) => x - y);
  const n = a.length;
  if (n === 0) return NaN;
  return n % 2 ? a[(n - 1) >> 1]! : (a[n / 2 - 1]! + a[n / 2]!) / 2;
};

const quantile = (xs: number[], q: number): number => {
  const a = [...xs].sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))]!;
};

interface Estimate {
  /** Envelope: offset(t) = intercept + slope·(t − ref). */
  ref: number;
  intercept: number;
  slope: number;
  lower: number | null;
  jitter: number;
}

export class SequencerClock {
  private readonly o: Required<SequencerClockOptions>;
  private secs: SecondRecord[] = [];
  private phase: { t: number; mod: number }[] = [];
  private curTs = -1;
  private curBlock: number | undefined;
  private lastArrival = -Infinity;
  private lastArrivalOfCur = -Infinity;
  private cache: Estimate | null = null;

  constructor(options: SequencerClockOptions = {}) {
    this.o = {
      windowMs: options.windowMs ?? 120_000,
      blockMs: options.blockMs ?? 100,
      minSeconds: options.minSeconds ?? 5,
      fallbackOffsetMs: options.fallbackOffsetMs ?? 60,
      driftCompensation: options.driftCompensation ?? true,
      minDriftPpm: options.minDriftPpm ?? 50,
      maxDriftPpm: options.maxDriftPpm ?? 500,
      minDriftSpanMs: options.minDriftSpanMs ?? 60_000,
      backlogGapMs: options.backlogGapMs ?? 20,
      historySeconds: options.historySeconds ?? 20,
    };
  }

  /**
   * Feed one block observation. `block` (optional) lets the clock tell contiguous blocks
   * apart from gaps, which is required for the lower-bound estimate.
   */
  ingest(blockTimestamp: number, arrivalMs: number, block?: number): void {
    const contiguous = block === undefined || this.curBlock === undefined || block === this.curBlock + 1;
    if (blockTimestamp > this.curTs) {
      const lowerOffsetMs =
        contiguous && blockTimestamp === this.curTs + 1 && Number.isFinite(this.lastArrivalOfCur)
          ? this.lastArrivalOfCur - blockTimestamp * 1000
          : undefined;
      this.secs.push({
        ts: blockTimestamp,
        firstArrivalMs: arrivalMs,
        offsetMs: arrivalMs - blockTimestamp * 1000,
        lowerOffsetMs,
        relArrivalsMs: [0],
      });
      this.curTs = blockTimestamp;
    } else if (blockTimestamp === this.curTs) {
      const cur = this.secs[this.secs.length - 1];
      if (cur && cur.ts === blockTimestamp) cur.relArrivalsMs.push(arrivalMs - cur.firstArrivalMs);
    } else {
      return; // out-of-order / replayed old block
    }
    if (arrivalMs - this.lastArrival >= this.o.backlogGapMs) {
      this.phase.push({ t: arrivalMs, mod: ((arrivalMs % this.o.blockMs) + this.o.blockMs) % this.o.blockMs });
    }
    this.lastArrival = arrivalMs;
    this.lastArrivalOfCur = arrivalMs;
    if (block !== undefined) this.curBlock = block;
    const cutoff = arrivalMs - this.o.windowMs;
    while (this.secs.length > 0 && this.secs[0]!.firstArrivalMs < cutoff) this.secs.shift();
    while (this.phase.length > 0 && this.phase[0]!.t < cutoff) this.phase.shift();
    this.cache = null;
  }

  /** Forget everything (e.g. after a long feed outage or host clock change). */
  reset(): void {
    this.secs = [];
    this.phase = [];
    this.curTs = -1;
    this.curBlock = undefined;
    this.lastArrival = -Infinity;
    this.lastArrivalOfCur = -Infinity;
    this.cache = null;
  }

  get ready(): boolean {
    return this.secs.length >= this.o.minSeconds;
  }

  private estimate(): Estimate | null {
    if (this.cache) return this.cache;
    const s = this.secs;
    if (s.length === 0) return null;
    const ref = s[s.length - 1]!.firstArrivalMs;
    let slope = 0;
    const span = s[s.length - 1]!.firstArrivalMs - s[0]!.firstArrivalMs;
    if (this.o.driftCompensation && span >= this.o.minDriftSpanMs) {
      // Lower envelope per ≥10 s bucket, Theil–Sen slope through the bucket minima (robust to
      // latency spikes; short spans are too noisy and are ignored entirely).
      const B = Math.max(3, Math.min(12, Math.floor(span / 10_000)));
      const pts: { t: number; o: number }[] = [];
      for (let b = 0; b < B; b++) {
        const lo = s[0]!.firstArrivalMs + (span * b) / B;
        const hi = s[0]!.firstArrivalMs + (span * (b + 1)) / B;
        let best: SecondRecord | undefined;
        for (const r of s) {
          if (r.firstArrivalMs < lo || (b < B - 1 ? r.firstArrivalMs >= hi : r.firstArrivalMs > hi)) continue;
          if (!best || r.offsetMs < best.offsetMs) best = r;
        }
        if (best) pts.push({ t: best.firstArrivalMs - ref, o: best.offsetMs });
      }
      if (pts.length >= 3) {
        const slopes: number[] = [];
        for (let i = 0; i < pts.length; i++)
          for (let j = i + 1; j < pts.length; j++) {
            const dt = pts[j]!.t - pts[i]!.t;
            if (dt > 0) slopes.push((pts[j]!.o - pts[i]!.o) / dt);
          }
        const fitted = median(slopes);
        const max = this.o.maxDriftPpm * 1e-6;
        if (Number.isFinite(fitted) && Math.abs(fitted) * 1e6 >= this.o.minDriftPpm) slope = Math.max(-max, Math.min(max, fitted));
      }
    }
    let intercept = Infinity;
    for (const r of s) intercept = Math.min(intercept, r.offsetMs - slope * (r.firstArrivalMs - ref));
    const residuals = s.map((r) => r.offsetMs - slope * (r.firstArrivalMs - ref) - intercept);
    const lowers = s
      .filter((r) => r.lowerOffsetMs !== undefined)
      .map((r) => r.lowerOffsetMs! - slope * (r.firstArrivalMs - ref));
    this.cache = {
      ref,
      intercept,
      slope,
      lower: lowers.length >= 3 ? quantile(lowers, 0.9) : null,
      jitter: median(residuals),
    };
    return this.cache;
  }

  /** Current boundary offset (local ms − sequencer ms, at minimum feed latency), or null. */
  get offsetMs(): number | null {
    const e = this.estimate();
    return e ? e.intercept : null;
  }

  /** Median excess of first-of-second arrivals over the envelope (feed latency jitter). */
  get jitterMs(): number | null {
    return this.estimate()?.jitter ?? null;
  }

  /** Fitted drift of the local clock vs the sequencer, parts per million (0 if not significant). */
  get driftPpm(): number {
    return (this.estimate()?.slope ?? 0) * 1e6;
  }

  /** Block-grid phase: circular median of arrival mod blockMs. */
  get phaseMs(): number | null {
    const P = this.o.blockMs;
    if (this.phase.length < 10) return null;
    let sx = 0;
    let sy = 0;
    for (const p of this.phase) {
      const a = (2 * Math.PI * p.mod) / P;
      sx += Math.cos(a);
      sy += Math.sin(a);
    }
    const mean = ((Math.atan2(sy, sx) / (2 * Math.PI)) * P + P) % P;
    const wrap = (d: number): number => ((((d + P / 2) % P) + P) % P) - P / 2;
    const center = mean + median(this.phase.map((p) => wrap(p.mod - mean)));
    return ((center % P) + P) % P;
  }

  /**
   * Local time at which the first block with timestamp `ts` is delivered at minimum
   * latency (the "boundary" of second `ts` in the feed-arrival domain).
   */
  predictBoundaryMs(ts: number): number {
    const e = this.ready ? this.estimate() : null;
    if (!e) return ts * 1000 + this.o.fallbackOffsetMs;
    // offset(t) = intercept + slope·(t − ref); evaluate at the boundary itself.
    const t = ts * 1000 + e.intercept;
    return t + e.slope * (t - e.ref);
  }

  /** Predicted seal-grid arrival times inside second `ts` (uses the grid phase). */
  predictSealsMs(ts: number): number[] {
    const P = this.o.blockMs;
    const phase = this.phaseMs;
    const start = this.predictBoundaryMs(ts);
    if (phase === null) return Array.from({ length: Math.round(1000 / P) }, (_, k) => start + k * P);
    const first = start + ((((phase - (start % P)) % P) + P) % P);
    return Array.from({ length: Math.round(1000 / P) }, (_, k) => first + k * P);
  }

  /** Full burst plan (see `burstSchedule`). */
  planBurst(args: { launchTs: number; now: number; burst: BurstConfig; rttMs: number }): BurstPlan {
    const { launchTs, now, burst, rttMs } = args;
    const boundaryMs = this.predictBoundaryMs(launchTs + 1);
    const latestMs = this.predictBoundaryMs(launchTs + 2) - rttMs;
    const planned: number[] = [];
    let clipped = 0;
    const count = Math.max(0, Math.floor(burst.count));
    for (let i = 0; i < count; i++) {
      const t = boundaryMs - rttMs + burst.startMs + i * burst.spacingMs;
      if (t > latestMs) {
        clipped = count - i;
        break;
      }
      planned.push(t);
    }
    const times = planned.filter((t) => t >= now);
    const droppedPast = planned.length - times.length;
    if (droppedPast > 0 && now <= latestMs && (times.length === 0 || times[0]! - now >= 1)) {
      times.unshift(now);
    }
    return { times, boundaryMs, latestMs, droppedPast, clipped };
  }

  /**
   * Send times (absolute local ms) for a burst into the first block of `launchTs + 1`:
   * `boundary(T+1) − rtt + startMs + i·spacingMs`, clipped so the last send is
   * ≤ boundary(T+2) − rtt (landing at +2 s still only pays 0.19 %). Members whose time has
   * already passed are replaced by one immediate send at `now`; empty ⇒ too late.
   */
  burstSchedule(args: { launchTs: number; now: number; burst: BurstConfig; rttMs: number }): number[] {
    return this.planBurst(args).times;
  }

  snapshot(): ClockSnapshot {
    const e = this.ready ? this.estimate() : null;
    const profile: number[] = [];
    for (let k = 0; k < Math.round(1000 / this.o.blockMs) + 2; k++) {
      const xs = this.secs.filter((s) => s.relArrivalsMs.length > k).map((s) => s.relArrivalsMs[k]!);
      if (xs.length === 0) break;
      profile.push(median(xs));
    }
    return {
      ready: this.ready,
      seconds: this.secs.length,
      offsetMs: e ? e.intercept : null,
      lowerBoundOffsetMs: e ? e.lower : null,
      jitterMs: e ? e.jitter : null,
      driftPpm: e ? e.slope * 1e6 : 0,
      phaseMs: this.phaseMs,
      withinSecondProfileMs: profile,
      recentSeconds: this.secs.slice(-this.o.historySeconds).map((s) => ({ ...s, relArrivalsMs: [...s.relArrivalsMs] })),
    };
  }
}
