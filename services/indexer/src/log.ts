/** Minimal pino-compatible logger surface (so tests can pass a silent logger). */
export interface Log {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const silentLog: Log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
