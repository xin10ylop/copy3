import { SequencerClock, FeedStats } from '@hood/core';
import { describe, expect, it } from 'vitest';
import { loadConfig, redactedConfig, redactUrl } from '../src/config.js';
import { healthy, prometheus, type HealthState } from '../src/health.js';

describe('config', () => {
  it('paper defaults need nothing; send endpoints default to the node/public RPC', () => {
    const c = loadConfig({});
    expect(c.EXECUTION_MODE).toBe('paper');
    expect(c.SEND_ENDPOINTS).toEqual(['https://rpc.mainnet.chain.robinhood.com']);
    expect(c.ADDRESS_PREDICTION).toBe('none');
    expect(loadConfig({ FEED_URL_SECONDARY: 'wss://a, wss://b' }).FEED_URL_SECONDARY).toEqual(['wss://a', 'wss://b']);
  });

  it('live mode requires key, contract, endpoints and DB; secrets are redacted', () => {
    expect(() => loadConfig({ EXECUTION_MODE: 'live' })).toThrow(/EXECUTOR_PRIVATE_KEY/);
    const c = loadConfig({
      EXECUTION_MODE: 'live',
      EXECUTOR_PRIVATE_KEYS: `0x${'1'.repeat(64)},0x${'3'.repeat(64)}`,
      SNIPER_CONTRACT: `0x${'2'.repeat(40)}`,
      SEND_ENDPOINTS: 'https://rpc.mainnet.chain.robinhood.com,http://127.0.0.1:8547',
      DATABASE_URL: 'postgres://x',
      MAX_GAS_PRICE_GWEI: '0.5',
    });
    expect(c.MAX_GAS_PRICE_GWEI).toBe(0.5);
    expect(c.SEND_ENDPOINTS).toHaveLength(2);
    expect(JSON.stringify(redactedConfig(c))).not.toContain('1111111111');
  });

  it('redacts API keys embedded in endpoint URLs (Alchemy /v2/<key>)', () => {
    const key = 'AbCdEf0123456789xyzKEY';
    const c = loadConfig({
      NODE_HTTP: `https://robinhood-mainnet.g.alchemy.com/v2/${key}`,
      NODE_WS: `wss://robinhood-mainnet.g.alchemy.com/v2/${key}`,
      SEND_ENDPOINTS: `https://rpc.mainnet.chain.robinhood.com,https://robinhood-mainnet.g.alchemy.com/v2/${key}`,
    });
    const r = redactedConfig(c);
    expect(JSON.stringify(r)).not.toContain(key);
    expect(r.NODE_HTTP).toBe('https://robinhood-mainnet.g.alchemy.com/v2/***');
    expect(r.SEND_ENDPOINTS).toEqual(['https://rpc.mainnet.chain.robinhood.com/', 'https://robinhood-mainnet.g.alchemy.com/v2/***']);
    expect(redactUrl('http://10.66.0.1:8547')).toBe('http://10.66.0.1:8547/');
    expect(redactUrl('')).toBe('');
  });
});

describe('metrics', () => {
  it('exposes feed, clock (incl. per-second arrival offsets and within-second profile) and counters', () => {
    const clock = new SequencerClock({ minSeconds: 2 });
    for (let s = 0; s < 4; s++) for (let k = 0; k < 10; k++) clock.ingest(1000 + s, (1000 + s) * 1000 + 50 + k * 100 + (k === 3 ? 7 : 0), s * 10 + k);
    const feed = new FeedStats();
    feed.recordBlock({ block: 1, timestamp: 1003, txs: [], receivedAt: 1_003_950, headerKind: 3 }, 0.1);
    const s: HealthState = {
      mode: 'paper',
      startedAt: 0,
      now: 1_004_000,
      feed: feed.snapshot(),
      clock: clock.snapshot(),
      rttMs: 3,
      counters: { decisions: 2 },
      positions: [],
      lastError: null,
      nonce: null,
      plays: 1,
      armed: 0,
    };
    expect(healthy(s)).toBe(true);
    const text = prometheus(s);
    expect(text).toContain('sniper_up 1');
    expect(text).toContain('sniper_clock_offset_ms 50');
    expect(text).toContain('sniper_clock_second_offset_ms{ts="1003"} 50');
    expect(text).toContain('sniper_clock_within_second_ms{k="3"} 307');
    expect(text).toContain('sniper_decisions 2');
    expect(text.match(/# HELP sniper_clock_second_offset_ms /g)).toHaveLength(1);
    expect(healthy({ ...s, now: 1_010_000 })).toBe(false);
  });
});
