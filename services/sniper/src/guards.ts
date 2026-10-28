/**
 * Process-level last line of defence (reviewer M2): an unhandled rejection or an exception that
 * escaped a callback is logged (and reported) instead of killing the process — the sniper must
 * keep managing open positions when, e.g., the node answers 429 exactly while the feed is down.
 */
import type { Logger } from './log.js';

export type CrashKind = 'unhandledRejection' | 'uncaughtException';

interface ProcessLike {
  on(event: 'unhandledRejection', cb: (reason: unknown) => void): unknown;
  on(event: 'uncaughtException', cb: (err: Error, origin?: string) => void): unknown;
  off(event: 'unhandledRejection', cb: (reason: unknown) => void): unknown;
  off(event: 'uncaughtException', cb: (err: Error, origin?: string) => void): unknown;
}

export function installCrashGuards(logger: Logger, onCrash?: (kind: CrashKind, err: unknown) => void, proc: ProcessLike = process): () => void {
  const report = (kind: CrashKind, err: unknown): void => {
    try {
      onCrash?.(kind, err);
    } catch {
      /* reporting must not throw */
    }
  };
  const onRejection = (reason: unknown): void => {
    logger.error({ err: reason }, 'unhandledRejection (process kept alive)');
    report('unhandledRejection', reason);
  };
  const onException = (err: Error, origin?: string): void => {
    logger.error({ err, origin }, 'uncaughtException (process kept alive)');
    report('uncaughtException', err);
  };
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);
  return () => {
    proc.off('unhandledRejection', onRejection);
    proc.off('uncaughtException', onException);
  };
}
