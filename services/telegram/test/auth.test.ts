import { describe, expect, it } from 'vitest';
import { parseAdminIds } from '../src/auth.js';
import { ADMIN, callbackUpdate, commandUpdate, makeHarness, STRANGER } from './helpers.js';

describe('parseAdminIds', () => {
  it('parses comma/space separated numeric ids and dedupes', () => {
    expect(parseAdminIds('123, 456 789,123')).toEqual([123, 456, 789]);
    expect(parseAdminIds('')).toEqual([]);
    expect(parseAdminIds(undefined)).toEqual([]);
  });
  it('rejects usernames and garbage', () => {
    expect(() => parseAdminIds('@owner')).toThrow(/not a numeric/);
    expect(() => parseAdminIds('12a')).toThrow(/not a numeric/);
    expect(() => parseAdminIds('0')).toThrow(/out of range/);
  });
});

describe('admin-only middleware', () => {
  it('lets admins through', async () => {
    const h = makeHarness();
    await h.send(commandUpdate('/help', ADMIN));
    expect(h.texts()[0]).toContain('/status');
  });

  it('drops commands from non-admins without touching state', async () => {
    const h = makeHarness();
    await h.send(commandUpdate('/kill now', STRANGER));
    await h.send(commandUpdate('/plays', STRANGER));
    expect(h.calls).toEqual([]);
    expect(h.store.settings.size).toBe(0);
  });

  it('tells a stranger their id on /start only', async () => {
    const h = makeHarness();
    await h.send(commandUpdate('/start', STRANGER));
    expect(h.calls).toHaveLength(1);
    expect(h.texts()[0]).toContain(`${STRANGER.id}`);
    expect(h.texts()[0]).toContain('Not authorized');
  });

  it('refuses button presses from non-admins', async () => {
    const h = makeHarness();
    await h.send(callbackUpdate('play:approve:1', STRANGER));
    expect(h.calls).toEqual([{ method: 'answerCallbackQuery', payload: expect.objectContaining({ text: 'Not authorized' }) }]);
  });
});
