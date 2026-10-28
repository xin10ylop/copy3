/**
 * Gentle sequential JSON-RPC helper for LIVE=1 tests against the public RPC.
 * Sequential, 150 ms spacing, retry-on-429 (the public node is rate-limited and
 * NOT an archive node — only 'latest' state is readable).
 */
const RPC = process.env.PUBLIC_RPC ?? 'https://rpc.mainnet.chain.robinhood.com';

let last = 0;
async function spaced(): Promise<void> {
  const wait = 150 - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
}

export interface RpcError {
  code: number;
  message: string;
  data?: string;
}

export interface RpcResult<T> {
  result?: T;
  error?: RpcError;
}

/** Raw call that returns {result|error} (does not throw on execution reverts). */
export async function rpcRaw<T = string>(method: string, params: unknown[]): Promise<RpcResult<T>> {
  for (let attempt = 0; ; attempt++) {
    await spaced();
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429 && attempt < 8) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    return (await res.json()) as RpcResult<T>;
  }
}

/** Throwing variant for calls that must succeed. */
export async function rpc<T = string>(method: string, params: unknown[]): Promise<T> {
  const j = await rpcRaw<T>(method, params);
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

export const hex = (n: bigint): `0x${string}` => `0x${n.toString(16)}`;
