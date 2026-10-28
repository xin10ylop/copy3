import { describe, expect, it } from 'vitest';
import { Links } from '../src/format.js';
import { eventMessage, presetSummary, snipeAbortedMessage, snipeClosedMessage, snipeFilledMessage, snipeSentMessage, type FormatCtx } from '../src/messages.js';
import type { SendExtra } from '../src/messenger.js';
import { Notifier, snipeIdsFromPayload, snipeSteps, type NotifyChannel } from '../src/notifier.js';
import { Registry } from '../src/registry.js';
import { SETTINGS, type ArmedRow } from '../src/store.js';
import { FakeStore, FUNDER, makePlay, makeSnipe, NOW, silentLog, TX, WALLET } from './helpers.js';

const ctx: FormatCtx = { links: new Links(), ethUsd: 3000, tz: 'UTC', now: NOW };

describe('preset summary', () => {
  it('shows a disabled trailing stop as "trail off"', () => {
    expect(presetSummary({ trailing: null })).toContain('trail off');
    expect(presetSummary({})).toContain('trail +100%/-25%');
  });
});

describe('notification formatting from sample snipes', () => {
  it('snipe sent: mode, token links and burst summary', () => {
    const t = snipeSentMessage(makeSnipe(), ctx);
    expect(t).toContain('[LIVE] <b>SNIPE SENT</b> #7 · play #1 test play');
    expect(t).toContain('<b>Amlil ($AMLIL)</b>');
    expect(t).toContain('gmgn.ai/robinhood/token/0x2222222222222222222222222222222222222222');
    expect(t).toContain('buy 0.0700 ETH · burst 3 tx · nonces 41–43 · span 30 ms · via rpc.mainnet.chain.robinhood.com×2 nitro:8547×1 · mined×1 reverted×2');
    expect(t).toContain('matched armedWallet');
    expect(snipeSentMessage(makeSnipe({ mode: 'paper' }), ctx)).toContain('[PAPER] <b>SNIPE PLANNED</b>');
  });

  it('filled: entry mcap in k-USD, tax paid with percentage, seconds after launch', () => {
    const s = makeSnipe({
      status: 'open',
      entryPrice: 4.1e-9, // 4.1 ETH mcap
      tokensOut: 15_000_000n * 10n ** 18n,
      taxPaidWei: 4_326_000_000_000_000n, // 6.18 % of 0.07
      buyTs: new Date('2026-10-28T15:59:01Z'),
      buyBlock: 100,
    });
    const t = snipeFilledMessage(s, ctx);
    expect(t).toContain('<b>FILLED</b> #7');
    expect(t).toContain('entry mcap $12.3k (4.10 ETH) · bought 15.00M for 0.0700 ETH');
    expect(t).toContain('tax paid 0.0043 ETH (6.18%) · +1 s after launch · block 100');
    expect(t).toContain(`/tx/${TX}`);
  });

  it('closed: signed PnL in ETH and USD, % on cost, exit reason and hold time', () => {
    const s = makeSnipe({
      status: 'closed',
      entryPrice: 4.1e-9,
      buyTs: new Date('2026-10-28T15:59:01Z'),
      closedAt: new Date('2026-10-28T15:59:38Z'),
      realizedPnlEth: 0.0712,
      sells: [
        { reason: 'tp150', tokensIn: '1', quoteOut: '1' },
        { reason: 'trailing', tokensIn: '1', quoteOut: '1', txHash: TX },
      ],
    });
    const t = snipeClosedMessage(s, ctx);
    expect(t).toContain('<b>CLOSED +</b> #7');
    expect(t).toContain('PnL +0.0712 ETH (+$213.60) · +101.7% on 0.0700 ETH');
    expect(t).toContain('reason tp150 → trailing · held 37s');
    expect(t).toContain('exit tx');
    const loss = snipeClosedMessage(makeSnipe({ status: 'closed', realizedPnlEth: -0.028, notes: 'stop loss', closedAt: NOW, buyTs: new Date(NOW.getTime() - 125_000) }), ctx);
    expect(loss).toContain('<b>CLOSED -</b>');
    expect(loss).toContain('PnL -0.0280 ETH (-$84.00) · -40.0%');
    expect(loss).toContain('reason stop loss · held 2m 05s');
  });

  it('aborted / failed: reason from notes or decision', () => {
    expect(snipeAbortedMessage(makeSnipe({ status: 'aborted', notes: 'exempt wallet sold in launch block', burst: [] }), ctx)).toContain('reason: exempt wallet sold in launch block');
    const f = snipeAbortedMessage(makeSnipe({ status: 'failed', decision: { abortReason: 'nonce too low' } }), ctx);
    expect(snipeSentMessage(makeSnipe({ decision: { reasons: ['armedWallet', 'nameRegex'] } }), ctx)).toContain('matched armedWallet+nameRegex');
    const fromDecision = snipeFilledMessage(makeSnipe({ status: 'open', launchTs: null, decision: { launch: { ts: 1_793_203_140 } }, buyTs: new Date(1_793_203_141_000) }), ctx);
    expect(fromDecision).toContain('+1 s after launch');
    expect(f).toContain('<b>FAILED</b>');
    expect(f).toContain('nonce too low');
  });

  it('error events show source/type and the message, HTML-escaped', () => {
    const t = eventMessage({ id: 1, ts: NOW, level: 'error', source: 'sniper', type: 'send_failed', payload: { message: 'ECONNRESET <rpc>' } }, ctx);
    expect(t).toContain('<b>[ERROR]</b> sniper/send_failed');
    expect(t).toContain('<pre>ECONNRESET &lt;rpc&gt;</pre>');
  });
});

describe('snipe lifecycle diff', () => {
  it('derives the messages a status change needs', () => {
    expect(snipeSteps(undefined, { status: 'pending', burst: [] })).toEqual(['sent']);
    expect(snipeSteps(undefined, { status: 'closed', burst: [] })).toEqual(['sent', 'filled', 'closed']);
    expect(snipeSteps('pending', { status: 'open', burst: [] })).toEqual(['filled']);
    expect(snipeSteps('open', { status: 'closed', burst: [] })).toEqual(['closed']);
    expect(snipeSteps('open', { status: 'open', burst: [] })).toEqual([]);
    expect(snipeSteps('pending', { status: 'aborted', burst: [] })).toEqual(['aborted']);
    expect(snipeSteps(undefined, { status: 'failed', burst: [] })).toEqual(['aborted']);
  });

  it('parses NOTIFY payloads', () => {
    expect(snipeIdsFromPayload('{"id":12,"status":"open"}')).toEqual([12]);
    expect(snipeIdsFromPayload('{"snipeId":3}')).toEqual([3]);
    expect(snipeIdsFromPayload('7')).toEqual([7]);
    expect(snipeIdsFromPayload('not json')).toEqual([]);
  });
});

function makeNotifier(store: FakeStore, over: { registry?: Registry; active?: Set<string>; now?: () => Date; hour?: number; deliver?: boolean } = {}) {
  const sent: Array<{ html: string; extra?: SendExtra }> = [];
  const listeners = new Map<NotifyChannel, (p: string) => void>();
  const registry = over.registry ?? new Registry();
  const notifier = new Notifier(
    {
      store,
      broadcast: async (html, extra) => {
        if (over.deliver === false) return 0;
        sent.push({ html, ...(extra ? { extra } : {}) });
        return 1;
      },
      chatCount: 1,
      registry,
      activeJobKinds: () => over.active ?? new Set(),
      listen: async (channel, cb) => {
        listeners.set(channel, cb);
        return async () => undefined;
      },
      log: silentLog,
      now: over.now ?? (() => NOW),
    },
    { pollMs: 60_000, dailySummaryHour: over.hour ?? 23, tz: 'UTC', links: new Links(), ignoreSources: ['telegram'], armedBurstLimit: 3 },
  );
  return { notifier, sent, listeners, registry };
}

const armedRow = (id: number): ArmedRow => ({
  id,
  playId: 1,
  playName: 'op',
  wallet: WALLET,
  sourceFunder: FUNDER,
  fundedValueWei: 57_000_000_000_000_000n,
  fundedTx: TX,
  armedAt: NOW,
  expiresAt: new Date(NOW.getTime() + 48 * 3600_000),
  status: 'armed',
});

describe('Notifier', () => {
  it('starts from "now": existing rows are not replayed', async () => {
    const store = new FakeStore();
    store.addEvent({ level: 'error', source: 'sniper', type: 'old', payload: {} });
    store.armed.push(armedRow(1));
    store.snipes.set(1, makeSnipe({ id: 1, status: 'closed' }));
    const { notifier, sent } = makeNotifier(store);
    await notifier.start();
    await notifier.stop();
    expect(sent).toEqual([]);
    expect(store.settings.get(SETTINGS.eventsCheckpoint)).toEqual({ id: 1 });
  });

  it('follows a snipe through sent → filled → closed, waking on NOTIFY snipe_events', async () => {
    const store = new FakeStore();
    const { notifier, sent, listeners } = makeNotifier(store);
    await notifier.start();
    store.snipes.set(7, makeSnipe());
    listeners.get('snipe_events')!('{"id":7}');
    await notifier.tick();
    expect(sent.map((s) => s.html.split('\n')[0])).toEqual(['[LIVE] <b>SNIPE SENT</b> #7 · play #1 test play']);

    store.snipes.get(7)!.status = 'open';
    store.snipes.get(7)!.entryPrice = 4e-9;
    await notifier.onNotify('snipe_events', '{"id":7}');
    store.snipes.get(7)!.status = 'closed';
    store.snipes.get(7)!.realizedPnlEth = 0.05;
    store.snipes.get(7)!.closedAt = NOW;
    await notifier.onNotify('snipe_events', '{"id":7}');
    await notifier.tick(); // nothing new
    expect(sent.map((s) => s.html.split('\n')[0])).toEqual([
      '[LIVE] <b>SNIPE SENT</b> #7 · play #1 test play',
      '[LIVE] <b>FILLED</b> #7 · play #1 test play',
      '[LIVE] <b>CLOSED +</b> #7 · play #1 test play',
    ]);
    expect(store.settings.get(SETTINGS.snipesCheckpoint)).toEqual({ maxId: 7, open: {} });
    await notifier.stop();
  });

  it('resumes from the stored checkpoint after a restart without duplicates', async () => {
    const store = new FakeStore();
    store.snipes.set(7, makeSnipe({ status: 'open' }));
    store.settings.set(SETTINGS.snipesCheckpoint, { maxId: 7, open: { '7': 'open' } });
    store.settings.set(SETTINGS.eventsCheckpoint, { id: 0 });
    store.settings.set(SETTINGS.armedCheckpoint, { id: 0 });
    store.snipes.get(7)!.status = 'closed';
    const { notifier, sent } = makeNotifier(store);
    await notifier.start();
    await notifier.tick();
    expect(sent.map((s) => s.html.split('\n')[0])).toEqual(['[LIVE] <b>CLOSED -</b> #7 · play #1 test play']);
    await notifier.stop();
  });

  it('announces new armed wallets, and summarises bursts', async () => {
    const store = new FakeStore();
    const { notifier, sent } = makeNotifier(store);
    await notifier.start();
    store.armed.push(armedRow(1));
    await notifier.onNotify('armed_changed', '');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain('<b>ARMED</b> play #1 <b>op</b>');
    expect(sent[0]!.html).toContain('funded 0.0570 ETH by');
    store.armed.push(armedRow(2), armedRow(3), armedRow(4), armedRow(5));
    await notifier.onNotify('armed_changed', '');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.html).toContain('<b>ARMED</b> 4 wallets');
    await notifier.stop();
  });

  it('routes events: errors pushed, proposals carded with buttons, own and duplicate events skipped', async () => {
    const store = new FakeStore();
    store.addPlay(makePlay({ id: 3, name: 'op3' }));
    const registry = new Registry();
    registry.markRunReported(50);
    const { notifier, sent } = makeNotifier(store, { registry, active: new Set(['scout']) });
    await notifier.start();
    store.addEvent({ level: 'info', source: 'indexer', type: 'backfill_progress', payload: {} });
    store.addEvent({ level: 'error', source: 'sniper', type: 'send_failed', payload: { message: 'boom' } });
    store.addEvent({ level: 'info', source: 'agent', type: 'play_proposed', payload: { playId: 3, runId: 50, summary: 'three coins' } });
    store.addEvent({ level: 'info', source: 'agent', type: 'play_proposed', payload: { playId: 3 } });
    store.addEvent({ level: 'warn', source: 'telegram', type: 'kill_switch_on', payload: {} });
    store.addEvent({ level: 'info', source: 'agent', type: 'agent_run_finished', payload: { runId: 50, kind: 'play', summary: 'x' } });
    store.addEvent({ level: 'info', source: 'agent', type: 'scout_finished', payload: { runId: 51, childRuns: [52] } });
    store.addEvent({ level: 'info', source: 'agent', type: 'backtest_finished', payload: { runId: 53, summary: 'EV +0.01', reportPath: '/reports/bt.md' } });
    store.addEvent({ level: 'info', source: 'tracker', type: 'custom', payload: { notify: true, message: 'hello' } });
    await notifier.onNotify('plays_changed', '');
    expect(sent.map((s) => s.html.split('\n')[0])).toEqual([
      '<b>[ERROR]</b> sniper/send_failed · 2026-10-28 16:00:00 UTC',
      '<b>PLAY PROPOSED</b> <b>#3 op3</b> · from agent run #50',
      '<b>Backtest finished</b> run #53',
      '<b>[INFO]</b> tracker/custom · 2026-10-28 16:00:00 UTC',
    ]);
    expect(sent[1]!.extra?.reply_markup).toBeDefined();
    expect(store.settings.get(SETTINGS.eventsCheckpoint)).toEqual({ id: 9 });
    await notifier.stop();
  });

  it('delivers an event that committed late with a lower id (lookback window)', async () => {
    const store = new FakeStore();
    store.addEvent({ id: 10, level: 'info', source: 'x', type: 'y', payload: {} });
    const { notifier, sent } = makeNotifier(store);
    await notifier.start();
    store.addEvent({ id: 12, level: 'error', source: 'sniper', type: 'a', payload: {} });
    await notifier.tick();
    store.addEvent({ id: 11, level: 'error', source: 'agent', type: 'late', payload: {} });
    await notifier.tick();
    await notifier.tick();
    expect(sent.map((s) => s.html.split(' · ')[0])).toEqual(['<b>[ERROR]</b> sniper/a', '<b>[ERROR]</b> agent/late']);
    await notifier.stop();
  });

  it('keeps events queued while Telegram is unreachable', async () => {
    const store = new FakeStore();
    const { notifier } = makeNotifier(store, { deliver: false });
    await notifier.start();
    store.addEvent({ level: 'error', source: 'sniper', type: 'x', payload: {} });
    await notifier.tick();
    expect(store.settings.get(SETTINGS.eventsCheckpoint)).toEqual({ id: 0 });
    await notifier.stop();
  });

  it('announces kill switch flips made outside the bot (e.g. daily loss limit)', async () => {
    const store = new FakeStore();
    const { notifier, sent } = makeNotifier(store);
    await notifier.start();
    store.settings.set(SETTINGS.killSwitch, { on: true, reason: 'daily loss limit 0.5 ETH hit', by: 'sniper' });
    await notifier.onNotify('settings_changed', '{"key":"kill_switch"}');
    await notifier.onNotify('settings_changed', '{"key":"kill_switch"}');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain('KILL SWITCH ON</b> - daily loss limit 0.5 ETH hit (by sniper)');
    await notifier.stop();
  });

  it('sends the daily summary once per local day at the configured hour', async () => {
    const store = new FakeStore();
    let now = new Date('2026-10-28T07:59:00Z');
    const { notifier, sent } = makeNotifier(store, { hour: 8, now: () => now });
    await notifier.start();
    expect(sent).toHaveLength(0);
    now = new Date('2026-10-28T08:00:30Z');
    await notifier.tick();
    await notifier.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain('<b>Daily summary</b>');
    expect(store.settings.get(SETTINGS.dailySummaryLast)).toBe('2026-10-28');
    now = new Date('2026-10-29T08:01:00Z');
    await notifier.tick();
    expect(sent).toHaveLength(2);
    await notifier.stop();
  });
});
