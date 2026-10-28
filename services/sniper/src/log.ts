import { pino, stdSerializers, type Logger } from 'pino';

export type { Logger };

export function createLogger(level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { svc: 'sniper' },
    serializers: { err: stdSerializers.err },
    formatters: { level: (label) => ({ level: label }) },
  });
}

/** Silent logger for tests. */
export const silentLogger: Logger = pino({ level: 'silent' });

/** JSON.stringify replacer that keeps bigint precision. */
export const bigintReplacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);
