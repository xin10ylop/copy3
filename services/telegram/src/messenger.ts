/**
 * Outgoing messages: HTML parse mode, link previews off, long texts split at 4096 chars,
 * flood-wait (429) retries, and a plain-text fallback if Telegram rejects the HTML.
 */
import { GrammyError, InputFile, type Api } from 'grammy';
import type { InlineKeyboard } from 'grammy';
import type { Logger } from 'pino';
import { splitMessage } from './format.js';

export interface SendExtra {
  reply_markup?: InlineKeyboard;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function stripHtml(html: string): string {
  return html
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

export class Messenger {
  constructor(
    private readonly api: Api,
    readonly notifyChatIds: readonly number[],
    private readonly log: Pick<Logger, 'warn' | 'error'>,
    private readonly maxRetries = 3,
  ) {}

  private async withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof GrammyError && err.error_code === 429 && attempt < this.maxRetries) {
          const wait = Math.min(30, err.parameters.retry_after ?? 1);
          this.log.warn({ what, wait }, 'telegram flood wait');
          await sleep(wait * 1000);
          continue;
        }
        throw err;
      }
    }
  }

  /** Send HTML to one chat; the keyboard goes on the last chunk. */
  async send(chatId: number, html: string, extra: SendExtra = {}): Promise<void> {
    const chunks = splitMessage(html);
    for (const [i, chunk] of chunks.entries()) {
      const last = i === chunks.length - 1;
      const markup = last && extra.reply_markup ? { reply_markup: extra.reply_markup } : {};
      try {
        await this.withRetry('sendMessage', () =>
          this.api.sendMessage(chatId, chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...markup }),
        );
      } catch (err) {
        if (err instanceof GrammyError && err.error_code === 400 && /parse entities|can't parse/i.test(err.description)) {
          this.log.warn({ chatId }, 'HTML rejected, resending as plain text');
          await this.withRetry('sendMessage', () => this.api.sendMessage(chatId, stripHtml(chunk), { link_preview_options: { is_disabled: true }, ...markup }));
        } else {
          throw err;
        }
      }
    }
  }

  /** Send to every notification chat (except `exceptChatId`); one failing chat does not stop the rest. */
  async broadcast(html: string, extra: SendExtra = {}, exceptChatId?: number): Promise<number> {
    let delivered = 0;
    for (const chatId of this.notifyChatIds) {
      if (chatId === exceptChatId) continue;
      try {
        await this.send(chatId, html, extra);
        delivered++;
      } catch (err) {
        this.log.error({ err, chatId }, 'broadcast to chat failed');
      }
    }
    return delivered;
  }

  async sendDocument(chatId: number, path: string, caption?: string): Promise<void> {
    await this.withRetry('sendDocument', () => this.api.sendDocument(chatId, new InputFile(path), caption ? { caption } : {}));
  }
}
