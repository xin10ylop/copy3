/**
 * Admin-only gate. Every update (messages, commands, button presses) must come from a user id
 * listed in TELEGRAM_ADMIN_IDS; everything else is dropped. A non-admin who sends /start in a
 * private chat is told their numeric id (so the owner can add it), nothing more.
 */
import type { Context, MiddlewareFn } from 'grammy';
import type { Logger } from 'pino';

/** "123, 456 789" → [123, 456, 789]; throws on anything that is not a positive integer. */
export function parseAdminIds(raw: string | undefined): number[] {
  const parts = (raw ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const ids = parts.map((p) => {
    if (!/^\d{1,16}$/.test(p)) throw new Error(`TELEGRAM_ADMIN_IDS: "${p}" is not a numeric Telegram user id`);
    const n = Number(p);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`TELEGRAM_ADMIN_IDS: "${p}" is out of range`);
    return n;
  });
  return [...new Set(ids)];
}

export function adminOnly(adminIds: ReadonlySet<number>, log: Pick<Logger, 'warn'>): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const id = ctx.from?.id;
    if (id !== undefined && adminIds.has(id)) {
      await next();
      return;
    }
    log.warn({ from: id, username: ctx.from?.username, chat: ctx.chat?.id, update: ctx.update.update_id }, 'unauthorized update dropped');
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: 'Not authorized' }).catch(() => undefined);
      return;
    }
    const text = ctx.message?.text ?? '';
    if (ctx.chat?.type === 'private' && /^\/start(@\w+)?(\s|$)/.test(text) && id !== undefined) {
      await ctx.reply(`Not authorized. Your Telegram user id is ${id}; the owner can add it to TELEGRAM_ADMIN_IDS.`).catch(() => undefined);
    }
  };
}

/** `@username` or `First (id)` for audit trails. */
export function userLabel(from: { id: number; username?: string; first_name?: string } | undefined): string {
  if (!from) return 'unknown';
  if (from.username) return `@${from.username}`;
  return `${from.first_name ?? 'user'} (${from.id})`;
}
