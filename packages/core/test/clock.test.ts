import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SequencerClock, type BurstConfig } from '../src/clock.js';
import { decodeFeedFrame } from '../src/feed/decoder.js';

/** Deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Scenario {
  seconds: number;
  /** seal phase of the 100 ms grid relative to the second tick */
  phaseMs: number;
  /** local = sequencer + offset(t) */
  offset: (seqMs: number) => number;
  latency: () => number;
  /** extra seal delay for a block (0 = on grid) */
  sealDelay?: () => number;
  /** probability a 100 ms slot has no block (no txs) */
  emptyProb?: number;
}

const T0 = 1_793_214_820; // seconds
const BURST: BurstConfig = { startMs: -120, spacingMs: 15, count: 10 };

function run(sc: Scenario, clock = new SequencerClock()): { clock: SequencerClock; truth: (ts: number) => number; latMin: number } {
  const r = rng(42);
  let block = 1000;
  let latMin = Infinity;
  for (let s = 0; s < sc.seconds; s++) {
    for (let k = 0; k < 10; k++) {
      if (k > 0 && sc.emptyProb && r() < sc.emptyProb) continue;
      const seal = (T0 + s) * 1000 + sc.phaseMs + k * 100 + (k > 0 ? (sc.sealDelay?.() ?? 0) : 0);
      const lat = sc.latency();
      latMin = Math.min(latMin, lat);
      clock.ingest(T0 + s, seal + lat + sc.offset(seal), block++);
    }
  }
  return {
    clock,
    latMin,
    truth: (ts) => {
      const seal = ts * 1000 + sc.phaseMs;
      return seal + latMin + sc.offset(seal);
    },
  };
}

describe('SequencerClock', () => {
  it('constant latency: boundary error < 1 ms, jitter ≈ 0', () => {
    const { clock, truth } = run({ seconds: 150, phaseMs: 7, offset: () => 12_345.6, latency: () => 3 });
    const ts = T0 + 151;
    expect(clock.ready).toBe(true);
    expect(Math.abs(clock.predictBoundaryMs(ts) - truth(ts))).toBeLessThan(1);
    expect(clock.jitterMs!).toBeLessThan(1);
    expect(Math.abs(clock.driftPpm)).toBe(0);
    // grid phase = (7 + 3 + 12345.6) mod 100
    expect(Math.abs(clock.phaseMs! - ((7 + 3 + 12_345.6) % 100))).toBeLessThan(0.5);
  });

  it('jittered latency + late seals + empty slots: error < burst spacing', () => {
    const r = rng(7);
    const { clock, truth } = run({
      seconds: 200,
      phaseMs: 12,
      offset: () => -4_000.25,
      latency: () => 4 + -Math.log(1 - r()) * 8, // exponential tail, mean 12 ms
      sealDelay: () => (r() < 0.3 ? r() * 50 : 0),
      emptyProb: 0.1,
    });
    const ts = T0 + 201;
    const err = Math.abs(clock.predictBoundaryMs(ts) - truth(ts));
    expect(err).toBeLessThan(BURST.spacingMs);
    expect(err).toBeLessThan(3);
    expect(clock.jitterMs!).toBeGreaterThan(2);
    expect(clock.jitterMs!).toBeLessThan(20);
  });

  it('clock drift (200 ppm) is tracked: error < spacing and drift estimated', () => {
    const r = rng(9);
    const drift = 200e-6;
    const start = T0 * 1000;
    const { clock, truth } = run({
      seconds: 240,
      phaseMs: 3,
      offset: (seq) => 500 + (seq - start) * drift,
      latency: () => 3 + r() * 6,
    });
    const ts = T0 + 241;
    const err = Math.abs(clock.predictBoundaryMs(ts) - truth(ts));
    expect(err).toBeLessThan(BURST.spacingMs);
    expect(err).toBeLessThan(4);
    expect(clock.driftPpm).toBeGreaterThan(120);
    expect(clock.driftPpm).toBeLessThan(280);
    // without drift compensation the 120 s window lags by ~drift·window
    const plain = run(
      { seconds: 240, phaseMs: 3, offset: (seq) => 500 + (seq - start) * drift, latency: () => 3 + rng(9)() * 6 },
      new SequencerClock({ driftCompensation: false }),
    );
    expect(Math.abs(plain.clock.predictBoundaryMs(ts) - plain.truth(ts))).toBeGreaterThan(err);
  });

  it('no spurious drift from jittered latency (live-like: exp tail, late seals)', () => {
    for (const seconds of [35, 150]) {
      const r = rng(seconds);
      const { clock, truth } = run({
        seconds,
        phaseMs: 8,
        offset: () => 777,
        latency: () => 3 + -Math.log(1 - r()) * 12,
        sealDelay: () => (r() < 0.3 ? r() * 60 : 0),
      });
      expect(clock.driftPpm).toBe(0);
      expect(Math.abs(clock.predictBoundaryMs(T0 + seconds + 1) - truth(T0 + seconds + 1))).toBeLessThan(BURST.spacingMs);
    }
  });

  it('ignores a backlog burst on connect (late arrivals cannot pull the estimate)', () => {
    const clock = new SequencerClock();
    // backlog: 30 old blocks delivered within 30 ms, 1-3 s late
    for (let i = 0; i < 30; i++) clock.ingest(T0 - 3 + Math.floor(i / 10), (T0 + 0.5) * 1000 + i, 500 + i);
    const { truth } = run({ seconds: 60, phaseMs: 5, offset: () => 0, latency: () => 2 }, clock);
    expect(Math.abs(clock.predictBoundaryMs(T0 + 61) - truth(T0 + 61))).toBeLessThan(1);
  });

  it('falls back to ts·1000 + fallbackOffset before it is ready', () => {
    const c = new SequencerClock({ fallbackOffsetMs: 40 });
    c.ingest(T0, T0 * 1000 + 5);
    expect(c.ready).toBe(false);
    expect(c.predictBoundaryMs(T0 + 1)).toBe((T0 + 1) * 1000 + 40);
  });

  describe('burstSchedule', () => {
    const { clock } = run({ seconds: 30, phaseMs: 10, offset: () => 0, latency: () => 5 });
    const launchTs = T0 + 31;
    const B = clock.predictBoundaryMs(launchTs + 1);
    const rttMs = 6;

    it('plans count members at spacing, starting startMs before boundary − rtt', () => {
      const times = clock.burstSchedule({ launchTs, now: B - 900, burst: BURST, rttMs });
      expect(times.length).toBe(10);
      expect(times[0]).toBeCloseTo(B - rttMs - 120, 6);
      for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeCloseTo(15, 6);
      // starts one block (+20 ms) before the predicted first T+1 seal and continues past it
      expect(times.at(-1)!).toBeGreaterThan(B - rttMs);
    });

    it('clips so the last send is ≤ boundary(T+2) − rtt', () => {
      const wide: BurstConfig = { startMs: -100, spacingMs: 100, count: 30 };
      const plan = clock.planBurst({ launchTs, now: B - 900, burst: wide, rttMs });
      expect(plan.times.at(-1)!).toBeLessThanOrEqual(clock.predictBoundaryMs(launchTs + 2) - rttMs);
      expect(plan.clipped).toBeGreaterThan(0);
      expect(plan.times.length + plan.clipped).toBe(30);
    });

    it('late detection: past members replaced by one immediate send', () => {
      const now = B - rttMs - 50; // the first 5 members (−120…−60) are already in the past
      const plan = clock.planBurst({ launchTs, now, burst: BURST, rttMs });
      expect(plan.droppedPast).toBe(5);
      expect(plan.times[0]).toBe(now);
      expect(plan.times.length).toBe(6);
    });

    it('too late (past boundary(T+2) − rtt) ⇒ empty', () => {
      const now = clock.predictBoundaryMs(launchTs + 2) - rttMs + 1;
      expect(clock.burstSchedule({ launchTs, now, burst: BURST, rttMs })).toEqual([]);
    });

    it('detected at +1.3 s ⇒ single immediate send', () => {
      const now = B + 300;
      expect(clock.burstSchedule({ launchTs, now, burst: BURST, rttMs })).toEqual([now]);
    });
  });

  it('calibrates on the captured feed frames (snapshot exposes per-second offsets)', () => {
    const lines = readFileSync(fileURLToPath(new URL('./fixtures/feed-frames.jsonl', import.meta.url)), 'utf8')
      .trim()
      .split('\n');
    const clock = new SequencerClock({ minSeconds: 3 });
    for (const l of lines) {
      const { receivedAt, frame } = JSON.parse(l) as { receivedAt: number; frame: unknown };
      for (const b of decodeFeedFrame(JSON.stringify(frame), receivedAt)) clock.ingest(b.timestamp, b.receivedAt, b.block);
    }
    const snap = clock.snapshot();
    expect(snap.ready).toBe(true);
    expect(snap.seconds).toBe(5);
    expect(snap.recentSeconds.map((s) => s.ts)).toEqual([1793214820, 1793214821, 1793214822, 1793214823, 1793214824]);
    // first-of-second offsets observed: 679 (backlog), 58, 50, 74, 78 ms ⇒ min filter = 50
    expect(snap.offsetMs).toBe(50);
    expect(snap.withinSecondProfileMs[0]).toBe(0);
    expect(snap.withinSecondProfileMs.length).toBeGreaterThanOrEqual(9);
    expect(snap.phaseMs).not.toBeNull();
    // eslint-disable-next-line no-console
    console.log('[clock] fixture snapshot', JSON.stringify({ ...snap, recentSeconds: snap.recentSeconds.map((s) => [s.ts, s.offsetMs, s.lowerOffsetMs, s.relArrivalsMs.map(Math.round)]) }));
  });
});
