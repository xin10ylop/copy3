import { createServer, type Server } from 'node:http';

export interface HealthStatus {
  ok: boolean;
  [k: string]: unknown;
}

/** GET /healthz -> 200 (ok) / 503 with a JSON body. */
export function startHealthServer(port: number, status: () => HealthStatus): Server {
  const server = createServer((req, res) => {
    if (req.url !== '/healthz' && req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    let body: HealthStatus;
    try {
      body = status();
    } catch (err) {
      body = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    res.writeHead(body.ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
  });
  server.listen(port);
  return server;
}
