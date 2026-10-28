import type { BacktestArgs, PlayFinderArgs, ScoutArgs } from '@hood/agent';
import type { WatchSpec } from '@hood/tracker';
import { describe, expect, it } from 'vitest';
import { JobRunner } from '../src/jobs.js';
import { normalizeAgentResult, normalizeWatchPlay, ServiceUnavailableError, type ScoutInput, type WatchPlayInput } from '../src/ports.js';
import { buildWatchPlayLocal } from '../src/stubs/tracker.js';
import { loadAgentPort, loadTrackerPort } from '../src/wiring.js';
import { FUNDER, silentLog } from './helpers.js';

describe('agent port binding', () => {
  it('binds runPlayFinder/runScout/runBacktest from the first module that has them', async () => {
    const mod = {
      runPlayFinder: async (a: { ca: string }) => ({ runId: 1, kind: 'play', summary: `found ${a.ca}`, reportPath: '/r/a.md', csvPath: '/r/a.csv', proposedPlays: [{ playId: 4 }], costUsd: 1.5, stop: 'end_turn' }),
      runScout: async () => ({ runId: 2, summary: 'Scout: 3 runners', reportPath: '/r/s.md', investigated: [{ runId: 3, proposedPlays: [{ playId: 8 }] }], costUsd: 0.4 }),
      runBacktest: async (a: { playId: number }) => ({ runId: 5, playId: a.playId, summary: 'EV +0.01', reportPath: '/r/b.md', csvPath: null, costUsd: 0 }),
    };
    const port = await loadAgentPort(silentLog, async (spec) => {
      if (spec === 'first') throw new Error('Cannot find module');
      return mod;
    }, ['first', 'second']);
    expect(port.available).toBe(true);
    expect(await port.runPlayFinder({ ca: '0xabc' })).toEqual({ runId: 1, summary: 'found 0xabc', reportPath: '/r/a.md', csvPath: '/r/a.csv', proposedPlayIds: [4], costUsd: 1.5, error: null });
    expect((await port.runScout({ sinceMinutes: 60, minPeak10Pct: 100 })).proposedPlayIds).toEqual([8]);
    expect((await port.runBacktest({ playId: 3 })).summary).toBe('EV +0.01');
  });

  it('falls back to the stub (clear error) when no module exports the runner', async () => {
    const port = await loadAgentPort(silentLog, async () => ({ somethingElse: 1 }), ['@hood/agent']);
    expect(port.available).toBe(false);
    await expect(port.runPlayFinder({ ca: '0x' })).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('normalises plain strings and unknown shapes', () => {
    expect(normalizeAgentResult('hi').summary).toBe('hi');
    expect(normalizeAgentResult({ finalText: 'x', proposedPlay: { playId: 2 }, error: 'budget' })).toMatchObject({ summary: 'x', proposedPlayIds: [2], error: 'budget' });
    expect(normalizeAgentResult(null)).toMatchObject({ summary: '', proposedPlayIds: [] });
  });
});

describe('tracker port binding', () => {
  it('validates what buildWatchPlay returns with the core schemas', async () => {
    const port = await loadTrackerPort(silentLog, async () => ({ buildWatchPlay: (i: { funder: string }) => ({ name: 'w', trigger: { armedWallet: { funders: [i.funder], minEth: 0.01, maxEth: 0.02 } }, preset: { buyEth: 0.05 } }) }), ['x']);
    expect(port.available).toBe(true);
    const play = await port.buildWatchPlay({ funder: FUNDER, minEth: 0.01, maxEth: 0.02, fresh: true });
    expect(play).toMatchObject({ name: 'w', preset: { buyEth: 0.05, maxTaxBps: 1000 }, trigger: { armedWallet: { funders: [FUNDER], freshOnly: true } } });
    const bad = await loadTrackerPort(silentLog, async () => ({ buildWatchPlay: () => ({ trigger: {}, preset: {} }) }), ['x']);
    await expect(bad.buildWatchPlay({ funder: FUNDER, minEth: 0, maxEth: 1, fresh: true })).rejects.toThrow(/armedWallet/);
  });

  it('falls back to the local builder with SPEC semantics', async () => {
    const port = await loadTrackerPort(silentLog, async () => {
      throw new Error('missing');
    }, ['x']);
    expect(port.available).toBe(false);
    const p = await port.buildWatchPlay({ funder: FUNDER, minEth: 0.057, maxEth: 0.174, fresh: false, name: 'n' });
    expect(p).toEqual(buildWatchPlayLocal({ funder: FUNDER, minEth: 0.057, maxEth: 0.174, fresh: false, name: 'n' }));
    expect(p.trigger).toMatchObject({ armedWallet: { funders: [FUNDER], minEth: 0.057, maxEth: 0.174, freshOnly: false, maxAgeSec: 172800, contractMode: true }, require: ['armedWallet'] });
    expect(() => normalizeWatchPlay({ trigger: { armedWallet: { funders: ['nope'] } } }, 'x')).toThrow();
  });
});

describe('JobRunner', () => {
  it('bounds concurrency, dedupes by key, queues, and reports results and errors', async () => {
    const jobs = new JobRunner({ concurrency: 1, maxQueue: 1, log: silentLog });
    const done: string[] = [];
    let release: () => void = () => undefined;
    const first = jobs.submit({ kind: 'play', key: 'a', label: 'a', run: () => new Promise<string>((r) => (release = () => r('A'))), onDone: async (r) => void done.push(r), onError: async () => undefined });
    expect(first).toMatchObject({ ok: true, queuedBehind: 0 });
    expect(jobs.activeKinds()).toEqual(new Set(['play']));
    expect(jobs.submit({ kind: 'play', key: 'a', label: 'a', run: async () => 'x', onDone: async () => undefined, onError: async () => undefined })).toMatchObject({ ok: false, error: expect.stringContaining('already running') });
    expect(jobs.submit({ kind: 'scout', key: 'b', label: 'b', run: async () => { throw new Error('nope'); }, onDone: async () => undefined, onError: async (e) => void done.push(`err:${(e as Error).message}`) })).toMatchObject({ ok: true, queuedBehind: 1 });
    expect(jobs.submit({ kind: 'backtest', key: 'c', label: 'c', run: async () => 'C', onDone: async () => undefined, onError: async () => undefined })).toMatchObject({ ok: false, error: expect.stringContaining('queue full') });
    release();
    await jobs.idle();
    expect(done).toEqual(['A', 'err:nope']);
    expect(jobs.size).toBe(0);
  });
});

describe('contract with the real services (default loader, no network)', () => {
  it('binds services/agent runPlayFinder/runScout/runBacktest by package name', async () => {
    const port = await loadAgentPort(silentLog);
    expect(port.available).toBe(true);
  });

  it('binds services/tracker buildWatchPlay and gets a valid armedWallet play back', async () => {
    const port = await loadTrackerPort(silentLog);
    expect(port.available).toBe(true);
    const p = await port.buildWatchPlay({ funder: FUNDER, minEth: 0.01, maxEth: 0.015, fresh: true, name: 'contract' });
    expect(p).toMatchObject({ name: 'contract', trigger: { armedWallet: { funders: [FUNDER], minEth: 0.01, maxEth: 0.015, freshOnly: true } }, preset: { buyEth: 0.07 } });
  });
});

// Compile-time contract: what the bot passes must be assignable to the real argument types.

type Assert<T extends true> = T;
export type ArgContracts = [
  Assert<{ ca: string } extends PlayFinderArgs ? true : false>,
  Assert<ScoutInput extends ScoutArgs ? true : false>,
  Assert<{ playId: number } extends BacktestArgs ? true : false>,
  Assert<WatchPlayInput extends WatchSpec ? true : false>,
];
