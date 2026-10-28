/** /healthz (JSON), /metrics (Prometheus text), /clock (full clock snapshot). */
import http from 'node:http';
import type { ClockSnapshot, FeedStatsSnapshot } from '@hood/core';

export interface HealthState {
  mode: 'live' | 'paper';
  startedAt: number;
  now: number;
  feed: FeedStatsSnapshot;
  clock: ClockSnapshot;
  rttMs: number;
  counters: Record<string, number>;
  positions: { key: string; token: string; pnlPct: number | null; tokensHeld: string; phase?: string }[];
  lastError: string | null;
  nonce: number | null;
  plays: number;
  armed: number;
}

const FEED_STALE_MS = 5000;

export function healthy(s: HealthState): boolean {
  return s.feed.lastReceivedAt !== null && s.now - s.feed.lastReceivedAt < FEED_STALE_MS;
}

export function prometheus(s: HealthState): string {
  const lines: string[] = [];
  const g = (name: string, v: number | null, help: string, labels = ''): void => {
    if (v === null || !Number.isFinite(v)) return;
    if (!lines.some((l) => l.startsWith(`# HELP ${name} `))) lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    lines.push(`${name}${labels} ${v}`);
  };
  g('sniper_up', healthy(s) ? 1 : 0, 'feed fresh within 5 s');
  g('sniper_live', s.mode === 'live' ? 1 : 0, '1 = live, 0 = paper');
  g('sniper_feed_blocks_total', s.feed.blocks, 'feed blocks received');
  g('sniper_feed_blocks_per_sec', s.feed.blocksPerSec, 'feed throughput (10 s window)');
  g('sniper_feed_gaps_total', s.feed.gaps, 'sequence gaps');
  g('sniper_feed_last_block', s.feed.lastBlock, 'last L2 block from the feed');
  g('sniper_feed_age_ms', s.feed.lastReceivedAt === null ? null : s.now - s.feed.lastReceivedAt, 'ms since the last frame');
  g('sniper_feed_raw_lag_ms', s.feed.rawLagMs, 'arrival − block timestamp of the last block');
  g('sniper_feed_decode_ms', s.feed.decodeMs.p50, 'frame decode time', '{q="0.5"}');
  g('sniper_feed_decode_ms', s.feed.decodeMs.p99, 'frame decode time', '{q="0.99"}');
  g('sniper_feed_decode_ms', s.feed.decodeMs.max, 'frame decode time', '{q="1"}');
  g('sniper_clock_ready', s.clock.ready ? 1 : 0, 'clock has enough seconds');
  g('sniper_clock_offset_ms', s.clock.offsetMs, 'boundary offset (min-filtered first-of-second arrival − ts·1000)');
  g('sniper_clock_lower_bound_offset_ms', s.clock.lowerBoundOffsetMs, 'last-of-previous-second arrival bound');
  g('sniper_clock_jitter_ms', s.clock.jitterMs, 'median excess of first-of-second arrivals');
  g('sniper_clock_drift_ppm', s.clock.driftPpm, 'fitted local-vs-sequencer drift');
  g('sniper_clock_phase_ms', s.clock.phaseMs, '100 ms seal-grid phase (arrival mod 100)');
  s.clock.withinSecondProfileMs.forEach((v, k) => g('sniper_clock_within_second_ms', v, 'median arrival of the k-th block of a second after the first', `{k="${k}"}`));
  for (const r of s.clock.recentSeconds) {
    g('sniper_clock_second_offset_ms', r.offsetMs, 'per-second first-arrival offset (arrival − ts·1000)', `{ts="${r.ts}"}`);
    g('sniper_clock_second_blocks', r.relArrivalsMs.length, 'blocks seen in that second', `{ts="${r.ts}"}`);
  }
  g('sniper_rtt_ms', s.rttMs, 'RTT used for burst timing');
  g('sniper_nonce', s.nonce, 'next executor nonce');
  g('sniper_plays', s.plays, 'enabled plays in memory');
  g('sniper_armed', s.armed, 'armed candidates in memory');
  g('sniper_positions_open', s.positions.length, 'open positions');
  g('sniper_positions_terminal', s.positions.filter((p) => p.phase === 'graduated' || p.phase === 'stuck').length, 'graduated / stuck positions needing manual action');
  for (const [k, v] of Object.entries(s.counters)) g(`sniper_${k}`, v, `counter ${k}`);
  return `${lines.join('\n')}\n`;
}

export function startHealthServer(port: number, state: () => HealthState): http.Server {
  const srv = http.createServer((req, res) => {
    const s = state();
    const url = req.url ?? '/';
    if (url.startsWith('/metrics')) {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(prometheus(s));
      return;
    }
    if (url.startsWith('/clock')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(s.clock));
      return;
    }
    const ok = healthy(s);
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok,
        ...s,
        clock: { ...s.clock, recentSeconds: s.clock.recentSeconds.slice(-5) },
      }),
    );
  });
  srv.listen(port);
  return srv;
}
