/**
 * Deploy PonsSniper to Robinhood Chain (chainId 4663). NOT run by tests or CI.
 *
 *   EXECUTOR_PRIVATE_KEY=0x…        deployer (pays gas; may be a burst key)
 *   OWNER=0x…                       REQUIRED cold owner (sweeps, admin) — must differ from every hot key
 *   OPERATORS=0x…,0x…               burst keys + exit key (EXECUTOR / EXIT addresses of services/sniper)
 *   [MAX_QUOTE_IN_ETH=0.2]          per-snipe cap enforced on-chain (owner can change it)
 *   [TREASURY=0x…]                  receiver of exit proceeds (default: the owner; printed as owner calldata)
 *   [FACTORY=0x7ed5…]               PonsV2LaunchFactory (default from @hood/core)
 *   [RPC_URL=https://rpc.mainnet.chain.robinhood.com] [FUND_ETH=0.2] [DRY_RUN=1]
 *   pnpm --filter @hood/contracts deploy
 *
 * The constructor makes the FIRST operator; the others are added with setOperator, which only
 * the owner can call — so with a cold OWNER this script prints the setOperator calldata for the
 * owner to submit instead of sending it.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getContractAddress,
  http,
  isAddress,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sniperAbi, sniperBytecode } from '../src/index.js';

const PONS_V2_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const rpcUrl = process.env.RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const pk = process.env.EXECUTOR_PRIVATE_KEY as Hex | undefined;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('EXECUTOR_PRIVATE_KEY (0x + 64 hex) required');

const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

const account = privateKeyToAccount(pk);
const owner = process.env.OWNER as Address | undefined;
if (!owner || !isAddress(owner)) throw new Error('OWNER (cold address) is required');
const operators = (process.env.OPERATORS ?? account.address)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean) as Address[];
if (operators.some((o) => !isAddress(o))) throw new Error('OPERATORS must be addresses');
if (operators.some((o) => o.toLowerCase() === owner.toLowerCase()) || owner.toLowerCase() === account.address.toLowerCase()) {
  if (process.env.ALLOW_HOT_OWNER !== '1') throw new Error('OWNER must be a cold key distinct from the deployer and every operator (ALLOW_HOT_OWNER=1 to override)');
}
const factory = (process.env.FACTORY ?? PONS_V2_FACTORY) as Address;
const treasury = process.env.TREASURY as Address | undefined;
if (treasury !== undefined && !isAddress(treasury)) throw new Error('TREASURY must be an address');
const maxQuoteIn = parseEther(process.env.MAX_QUOTE_IN_ETH ?? '0.2');

const publicClient = createPublicClient({ chain: robinhood, transport: http(rpcUrl) });
const wallet = createWalletClient({ account, chain: robinhood, transport: http(rpcUrl) });

async function main(): Promise<void> {
  const chainId = await publicClient.getChainId();
  if (chainId !== 4663) throw new Error(`unexpected chainId ${chainId}`);
  const nonce = await publicClient.getTransactionCount({ address: account.address });
  const predicted = getContractAddress({ from: account.address, nonce: BigInt(nonce) });
  console.log(`deployer ${account.address} nonce ${nonce} → PonsSniper at ${predicted}`);
  console.log(`owner ${owner} operators ${operators.join(',')} factory ${factory} maxQuoteIn ${maxQuoteIn}`);
  if (process.env.DRY_RUN === '1') return;

  const hash = await wallet.deployContract({ abi: sniperAbi, bytecode: sniperBytecode, args: [owner!, operators[0]!, factory, maxQuoteIn] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`deploy failed: ${hash}`);
  const address = receipt.contractAddress;
  const [o, isOp, arb, f] = await Promise.all([
    publicClient.readContract({ address, abi: sniperAbi, functionName: 'owner' }),
    publicClient.readContract({ address, abi: sniperAbi, functionName: 'operators', args: [operators[0]!] }),
    publicClient.readContract({ address, abi: sniperAbi, functionName: 'arbBlockNumbers' }),
    publicClient.readContract({ address, abi: sniperAbi, functionName: 'factory' }),
  ]);
  if (o.toLowerCase() !== owner!.toLowerCase() || !isOp || !arb || f.toLowerCase() !== factory.toLowerCase()) throw new Error('post-deploy check failed');

  for (const op of operators.slice(1)) {
    const data = encodeFunctionData({ abi: sniperAbi, functionName: 'setOperator', args: [op, true] });
    console.log(`owner must send: to=${address} data=${data}   # setOperator(${op}, true)`);
  }
  if (treasury) {
    const data = encodeFunctionData({ abi: sniperAbi, functionName: 'setTreasury', args: [treasury] });
    console.log(`owner must send: to=${address} data=${data}   # setTreasury(${treasury})`);
  }
  const fund = process.env.FUND_ETH;
  if (fund) {
    const tx = await wallet.sendTransaction({ to: address, value: parseEther(fund) });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`funded ${fund} ETH (${tx})`);
  }
  console.log(`SNIPER_CONTRACT=${address.toLowerCase()}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
