/**
 * viem chain definition + client factory for Robinhood Chain (SPEC §1).
 *
 * `robinhoodChain` is the chain (id 4663, native ETH, Blockscout explorer).
 * `makeClients` builds http + ws public clients for both our own node and the
 * public RPC. HTTP transports disable batching and set keep-alive for latency
 * on the hot path (we want each call to go out immediately, not be coalesced).
 */
import {
  createPublicClient,
  http,
  webSocket,
  defineChain,
  type Chain,
  type PublicClient,
  type HttpTransport,
  type WebSocketTransport,
} from 'viem';
import { factoryAbi } from './abis/index.js';
import { CHAIN_ID, PUBLIC_RPC_HTTP, PONS_V2 } from './addresses.js';

export const robinhoodChain: Chain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [PUBLIC_RPC_HTTP], webSocket: ['wss://feed.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
  contracts: {
    multicall3: { address: '0xca11bde05977b3631167028862be2a173976ca11' },
  },
});

export interface ClientEnv {
  /** our own nitro node http endpoint (preferred for reads). */
  nodeHttp?: string;
  /** our own nitro node ws endpoint (newHeads / logs subscriptions). */
  nodeWs?: string;
  /** the public RPC (fallback + sends). */
  publicRpc?: string;
}

/**
 * Low-latency HTTP transport: no request batching (so a single eth_call goes
 * out immediately) and a bounded retry.
 */
function lowLatencyHttp(url: string): HttpTransport {
  return http(url, {
    batch: false,
    retryCount: 2,
    retryDelay: 150,
    timeout: 10_000,
    fetchOptions: { keepalive: true },
  });
}

export interface Clients {
  /** primary read client (own node if provided, else public RPC). */
  node: PublicClient<HttpTransport>;
  /** public RPC client (always http). */
  publicRpc: PublicClient<HttpTransport>;
  /** ws client for subscriptions, if a ws url was given. */
  ws?: PublicClient<WebSocketTransport>;
}

/** Build viem public clients for Robinhood Chain. */
export function makeClients(env: ClientEnv): Clients {
  const publicUrl = env.publicRpc ?? PUBLIC_RPC_HTTP;
  const nodeUrl = env.nodeHttp ?? publicUrl;

  const node = createPublicClient({ chain: robinhoodChain, transport: lowLatencyHttp(nodeUrl) });
  const publicRpc = createPublicClient({ chain: robinhoodChain, transport: lowLatencyHttp(publicUrl) });

  const clients: Clients = { node, publicRpc };
  if (env.nodeWs) {
    clients.ws = createPublicClient({
      chain: robinhoodChain,
      transport: webSocket(env.nodeWs, { keepAlive: true, reconnect: true }),
    });
  }
  return clients;
}

export interface FactoryParams {
  snipeTaxStartBps: bigint;
  snipeTaxSeconds: bigint;
  launchFee: bigint;
  launchDeployer: `0x${string}`;
}

/** Read the live factory parameters needed by the clock/executor at startup. */
export async function readFactoryParams(
  client: Pick<PublicClient, 'readContract'>,
): Promise<FactoryParams> {
  const factory = PONS_V2.factory as `0x${string}`;
  const [snipeTaxStartBps, snipeTaxSeconds, launchFee, launchDeployer] = await Promise.all([
    client.readContract({ address: factory, abi: factoryAbi, functionName: 'snipeTaxStartBps' }),
    client.readContract({ address: factory, abi: factoryAbi, functionName: 'snipeTaxSeconds' }),
    client.readContract({ address: factory, abi: factoryAbi, functionName: 'launchFee' }),
    client.readContract({ address: factory, abi: factoryAbi, functionName: 'launchDeployer' }),
  ]);
  return {
    snipeTaxStartBps: snipeTaxStartBps as bigint,
    snipeTaxSeconds: snipeTaxSeconds as bigint,
    launchFee: launchFee as bigint,
    launchDeployer: (launchDeployer as string).toLowerCase() as `0x${string}`,
  };
}
