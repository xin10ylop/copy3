import { describe, expect, it } from 'vitest';
import { ADMIN, callbackUpdate, commandUpdate, FakeStore, FUNDER, makeHarness, makePlay } from './helpers.js';

const keyboardOf = (payload: Record<string, unknown>) =>
  (payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined)?.inline_keyboard;

describe('/watch → proposed play → approval buttons', () => {
  it('builds the watch play, stores it disabled + pending review, and sends approve/reject buttons', async () => {
    const h = makeHarness();
    await h.send(commandUpdate(`/watch ${FUNDER} 0.057 0.174 fresh "Amlil op"`));
    const play = h.store.plays.get(1)!;
    expect(play).toMatchObject({ name: 'Amlil op', enabled: false, createdBy: 'telegram:@owner' });
    expect(play.stats).toMatchObject({ review: { status: 'pending', source: 'watch', by: '@owner' } });
    expect(play.trigger).toMatchObject({ armedWallet: { funders: [FUNDER], minEth: 0.057, maxEth: 0.174, freshOnly: true }, require: ['armedWallet'] });
    expect(play.preset).toMatchObject({ buyEth: 0.07, maxTaxBps: 1000 });
    expect(h.store.notifies).toContainEqual({ channel: 'plays_changed', payload: { op: 'insert', playId: 1 } });
    expect(h.store.events.map((e) => e.type)).toEqual(['play_proposed']);

    const card = h.calls.find((c) => c.method === 'sendMessage')!;
    expect(String(card.payload.text)).toContain('PLAY PROPOSED');
    expect(String(card.payload.text)).toContain('0.057–0.174 ETH, fresh');
    expect(keyboardOf(card.payload)).toEqual([
      [
        { text: 'Approve', callback_data: 'play:approve:1' },
        { text: 'Reject', callback_data: 'play:reject:1' },
      ],
    ]);
    expect(h.registry.claimCard(1)).toBe(false); // the notifier will not card it again
  });

  it('copies the preset of another play with preset=<id>', async () => {
    const store = new FakeStore();
    store.addPlay(makePlay({ id: 5, preset: { buyEth: 0.03, stopLossPct: 30 } }));
    const h = makeHarness({ store });
    await h.send(commandUpdate(`/watch ${FUNDER} 0.01 0.015 any preset=5`));
    expect(store.plays.get(6)).toMatchObject({ preset: { buyEth: 0.03, stopLossPct: 30 }, trigger: { armedWallet: { freshOnly: false } } });
  });

  it('answers usage errors without writing anything', async () => {
    const h = makeHarness();
    await h.send(commandUpdate('/watch 0x123 0.1'));
    expect(h.store.plays.size).toBe(0);
    expect(h.texts()[0]).toContain('usage');
  });
});

describe('approve / reject callbacks', () => {
  const setup = () => {
    const store = new FakeStore();
    store.addPlay(makePlay({ id: 3, name: 'op3', stats: { review: { status: 'pending' } } }));
    return makeHarness({ store });
  };

  it('approve enables the play, records the reviewer, NOTIFYs, edits the card and removes the buttons', async () => {
    const h = setup();
    await h.send(callbackUpdate('play:approve:3'));
    const play = h.store.plays.get(3)!;
    expect(play.enabled).toBe(true);
    expect(play.stats.review).toMatchObject({ status: 'approved', by: '@owner' });
    expect(h.store.notifies).toContainEqual({ channel: 'plays_changed', payload: { op: 'enable', playId: 3 } });
    expect(h.store.events.map((e) => [e.type, e.payload])).toEqual([['play_approved', { playId: 3, by: '@owner' }]]);
    const answer = h.calls.find((c) => c.method === 'answerCallbackQuery')!;
    expect(answer.payload.text).toBe('Play #3 approved and enabled');
    const edit = h.calls.find((c) => c.method === 'editMessageText')!;
    expect(String(edit.payload.text)).toContain('APPROVED</b> by @owner');
    expect(edit.payload.reply_markup).toBeUndefined();
  });

  it('a second approve is idempotent', async () => {
    const h = setup();
    await h.send(callbackUpdate('play:approve:3'));
    h.calls.length = 0;
    await h.send(callbackUpdate('play:approve:3'));
    expect(h.calls.find((c) => c.method === 'answerCallbackQuery')!.payload.text).toBe('Play #3 is already enabled');
    expect(h.store.events.filter((e) => e.type === 'play_approved')).toHaveLength(1);
  });

  it('reject keeps the play disabled and records the decision', async () => {
    const h = setup();
    await h.send(callbackUpdate('play:reject:3'));
    const play = h.store.plays.get(3)!;
    expect(play.enabled).toBe(false);
    expect(play.stats.review).toMatchObject({ status: 'rejected', by: '@owner' });
    expect(h.calls.find((c) => c.method === 'answerCallbackQuery')!.payload.text).toBe('Play #3 rejected');
    expect(String(h.calls.find((c) => c.method === 'editMessageText')!.payload.text)).toContain('REJECTED');
  });

  it('refuses to enable a play whose preset is invalid', async () => {
    const store = new FakeStore();
    store.addPlay(makePlay({ id: 4, preset: { buyEth: -5 } }));
    const h = makeHarness({ store });
    await h.send(callbackUpdate('play:approve:4'));
    expect(store.plays.get(4)!.enabled).toBe(false);
    const answer = h.calls.find((c) => c.method === 'answerCallbackQuery')!;
    expect(answer.payload).toMatchObject({ show_alert: true, text: expect.stringContaining('preset is invalid') });
  });

  it('unknown play ids and unknown buttons are answered, not crashed on', async () => {
    const h = setup();
    await h.send(callbackUpdate('play:approve:99'));
    expect(h.calls.find((c) => c.method === 'answerCallbackQuery')!.payload.text).toBe('Play #99 not found');
    await h.send(callbackUpdate('something:else'));
    expect(h.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload.text)).toContain('Unknown or expired button');
  });

  it('/play_on also approves a pending play; /play_off disables it', async () => {
    const h = setup();
    await h.send(commandUpdate('/play_on 3', ADMIN));
    expect(h.store.plays.get(3)).toMatchObject({ enabled: true, stats: { review: { status: 'approved' } } });
    await h.send(commandUpdate('/play_off 3', ADMIN));
    expect(h.store.plays.get(3)!.enabled).toBe(false);
    expect(h.store.events.map((e) => e.type)).toEqual(['play_enabled', 'play_disabled']);
  });
});
