import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS } from '../src/store.js';
import { ADMIN, commandUpdate, fakeAgent, FakeStore, makeHarness, makePlay, makeSnipe, TOKEN } from './helpers.js';

describe('/preset', () => {
  const setup = () => {
    const store = new FakeStore();
    store.addPlay(makePlay({ id: 2, name: 'op2', enabled: true, preset: { buyEth: 0.07 } }));
    return makeHarness({ store });
  };

  it('shows the current preset as key=value lines', async () => {
    const h = setup();
    await h.send(commandUpdate('/preset 2'));
    expect(h.texts()[0]).toContain('trailing.activatePct=100');
    expect(h.texts()[0]).toContain('buyEth=0.07');
  });

  it('updates nested keys, persists, NOTIFYs and reports the diff', async () => {
    const h = setup();
    await h.send(commandUpdate('/preset 2 trailing.activatePct=80 buy=0.05 tp=100:50,200:100'));
    expect(h.store.plays.get(2)!.preset).toMatchObject({ buyEth: 0.05, trailing: { activatePct: 80, dropPct: 25 }, takeProfits: [{ pct: 100, sellPct: 50 }, { pct: 200, sellPct: 100 }] });
    expect(h.store.notifies).toContainEqual({ channel: 'plays_changed', payload: { op: 'preset', playId: 2 } });
    const text = h.texts()[0]!;
    expect(text).toContain('trailing.activatePct: 100 → <b>80</b>');
    expect(text).toContain('buyEth: 0.07 → <b>0.05</b>');
    expect(text).toContain('sniper reloads it');
    expect(h.store.events.find((e) => e.type === 'preset_changed')!.payload).toMatchObject({ playId: 2, by: '@owner' });
  });

  it('accepts trailing=off and shows it in the diff', async () => {
    const h = setup();
    await h.send(commandUpdate('/preset 2 trailing=off'));
    expect(h.store.plays.get(2)!.preset).toMatchObject({ trailing: null });
    expect(h.texts()[0]).toContain('trailing: {"activatePct":100,"dropPct":25} → <b>off</b>');
  });

  it('rejects unknown keys and invalid values without writing', async () => {
    const h = setup();
    await h.send(commandUpdate('/preset 2 trailing.activatPct=80'));
    await h.send(commandUpdate('/preset 2 buyEth=abc'));
    await h.send(commandUpdate('/preset 2 buyEth=5'));
    await h.send(commandUpdate('/preset x buyEth=1'));
    await h.send(commandUpdate('/preset 9 buyEth=0.1'));
    const t = h.texts();
    expect(t[0]).toContain('unknown key');
    expect(t[1]).toContain('buyEth: Invalid input');
    expect(t[2]).toContain('TELEGRAM_MAX_BUY_ETH');
    expect(t[3]).toContain('usage');
    expect(t[4]).toContain('not found');
    expect(h.store.plays.get(2)!.preset).toEqual({ buyEth: 0.07 });
  });
});

describe('/play (background job)', () => {
  it('validates the contract address', async () => {
    const agent = fakeAgent();
    const h = makeHarness({ agent });
    await h.send(commandUpdate('/play 0x1234'));
    expect(h.texts()[0]).toContain('invalid contract address');
    expect(agent.calls).toEqual([]);
  });

  it('replies at once, runs the agent in the background, then sends summary, CSV, report and approval card', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hood-tg-'));
    writeFileSync(join(dir, 'play.csv'), 'ca\n');
    writeFileSync(join(dir, 'play.md'), '# report\n');
    const store = new FakeStore();
    store.addPlay(makePlay({ id: 12, name: 'proposed op' }));
    const agent = fakeAgent({
      runPlayFinder: async () => ({ runId: 9, summary: 'Operator X: 5 coins', reportPath: 'play.md', csvPath: join(dir, 'play.csv'), proposedPlayIds: [12], costUsd: 2.5, error: null }),
    });
    const h = makeHarness({ store, agent, config: { reportsDir: dir } });
    await h.send(commandUpdate(`/play ${TOKEN.toUpperCase().replace('0X', '0x')}`));
    expect(h.texts()[0]).toContain('Started play');
    await h.jobs.idle();
    await new Promise((r) => setTimeout(r, 0));
    const methods = h.calls.map((c) => c.method);
    expect(methods).toEqual(['sendMessage', 'sendMessage', 'sendDocument', 'sendDocument', 'sendMessage']);
    expect(h.texts()[1]).toContain('Play finder done');
    expect(h.texts()[1]).toContain('Operator X: 5 coins');
    expect(h.texts()[1]).toContain('cost $2.50');
    expect(h.calls.filter((c) => c.method === 'sendDocument').map((c) => c.payload.caption)).toEqual(['CSV · 0x2222…2222', 'report · 0x2222…2222']);
    expect(h.texts()[2]).toContain('PLAY PROPOSED');
    expect(h.registry.runReported(9)).toBe(true);
  });

  it('refuses a duplicate run for the same coin and reports agent failures', async () => {
    let release: () => void = () => undefined;
    const agent = fakeAgent({
      runPlayFinder: () =>
        new Promise((_, reject) => {
          release = () => reject(new Error('budget exhausted'));
        }),
    });
    const h = makeHarness({ agent });
    await h.send(commandUpdate(`/play ${TOKEN}`));
    await h.send(commandUpdate(`/play ${TOKEN}`));
    expect(h.texts()[1]).toContain('already running');
    release();
    await h.jobs.idle();
    expect(h.texts().at(-1)).toContain('budget exhausted');
  });

  it('says so when the agent is not bound', async () => {
    const h = makeHarness({ agent: { ...fakeAgent(), available: false } });
    await h.send(commandUpdate(`/play ${TOKEN}`));
    expect(h.texts()[0]).toContain('not available');
  });

  it('/scout and /backtest pass their arguments', async () => {
    const store = new FakeStore();
    store.addPlay(makePlay({ id: 4 }));
    const agent = fakeAgent();
    const h = makeHarness({ store, agent });
    await h.send(commandUpdate('/scout 120 200'));
    await h.jobs.idle();
    await h.send(commandUpdate('/backtest 4'));
    await h.jobs.idle();
    await h.send(commandUpdate('/backtest 99'));
    expect(agent.calls).toEqual([
      ['scout', { sinceMinutes: 120, minPeak10Pct: 200 }],
      ['backtest', { playId: 4 }],
    ]);
    expect(h.texts().at(-1)).toContain('Play #99 not found');
  });
});

describe('kill switch', () => {
  it('/kill stores the switch, NOTIFYs settings_changed, replies and broadcasts to the other chats', async () => {
    const h = makeHarness();
    await h.send(commandUpdate('/kill operator rugged twice'));
    expect(h.store.settings.get(SETTINGS.killSwitch)).toMatchObject({ on: true, reason: 'operator rugged twice', by: '@owner' });
    expect(h.store.notifies).toContainEqual({ channel: 'settings_changed', payload: { key: 'kill_switch' } });
    const sends = h.calls.filter((c) => c.method === 'sendMessage');
    expect(sends.map((c) => c.payload.chat_id)).toEqual([ADMIN.id, -100200]);
    expect(String(sends[0]!.payload.text)).toContain('KILL SWITCH ON');
    expect(h.registry.kill).toMatchObject({ on: true });
    await h.send(commandUpdate('/resume'));
    expect(h.store.settings.get(SETTINGS.killSwitch)).toMatchObject({ on: false });
    expect(h.texts().at(-1)).toContain('Trading resumed');
    expect(h.store.events.map((e) => e.type)).toEqual(['kill_switch_on', 'kill_switch_off']);
  });
});

describe('read-only views', () => {
  it('/status shows feed, chain heads, kill state, positions and daily PnL', async () => {
    const store = new FakeStore();
    store.settings.set(SETTINGS.ethUsd, 3000);
    const h = makeHarness({ store });
    await h.send(commandUpdate('/status'));
    const t = h.texts()[0]!;
    expect(t).toContain('feed: block 100302108');
    expect(t).toContain('lag 8 blocks');
    expect(t).toContain('indexer 100302000');
    expect(t).toContain('kill switch: off');
    expect(t).toContain('positions: 1 live, 2 paper');
    expect(t).toContain('PnL today (UTC): live +0.0123 ETH (+$36.90)');
    expect(t).toContain('ETH/USD: $3,000');
  });

  it('/positions lists open snipes with unrealised PnL', async () => {
    const store = new FakeStore();
    store.snipes.set(7, makeSnipe({ status: 'open', entryPrice: 4e-9, lastPrice: 6e-9, tokensOut: 15_000_000n * 10n ** 18n }));
    const h = makeHarness({ store });
    await h.send(commandUpdate('/positions'));
    const t = h.texts()[0]!;
    expect(t).toContain('Open positions: 1');
    expect(t).toContain('+50.0%');
    expect(t).toContain('value 0.0900 ETH');
  });

  it('/plays, /armed, /pnl render and /pnl validates days', async () => {
    const store = new FakeStore();
    store.addPlay(makePlay({ id: 1, enabled: true }));
    store.pnl.live = { closed: 3, wins: 2, losses: 1, pnlEth: 0.05, bestEth: 0.04, worstEth: -0.02, aborted: 1, failed: 0, taxPaidWei: 13_000_000_000_000_000n, investedWei: 210_000_000_000_000_000n };
    const h = makeHarness({ store });
    await h.send(commandUpdate('/plays'));
    await h.send(commandUpdate('/armed'));
    await h.send(commandUpdate('/pnl 7'));
    await h.send(commandUpdate('/pnl 0'));
    const t = h.texts();
    expect(t[0]).toContain('[ON]');
    expect(t[1]).toBe('No armed wallets.');
    expect(t[2]).toContain('last 7 days');
    expect(t[2]).toContain('+0.0500 ETH over 3 closed (2W/1L, 67% win)');
    expect(t[3]).toContain('between 1 and 365');
  });

  it('unknown commands get a hint', async () => {
    const h = makeHarness();
    await h.send(commandUpdate('/nope'));
    expect(h.texts()[0]).toContain('/help');
  });
});
