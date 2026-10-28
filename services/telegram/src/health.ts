/** GET /healthz → 200 {"ok":true,...} while the bot polls and the database answers; 503 otherwise. */
import { createServer, type Server } from 'node:http';

export interface HealthState {
  check: () => Promise<{ ok: boolean; detail: Record<string, unknown> }>;
}

export function startHealthServer(port: number, state: HealthState): Server {
  const server = createServer((req, res) => {
    if (req.url !== '/healthz' && req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    state
      .check()
      .then(({ ok, detail }) => {
        res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ ok, ...detail }));
      })
      .catch((err: unknown) => {
        res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(err) }));
      });
  });
  server.listen(port);
  return server;
}
