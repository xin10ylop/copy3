/**
 * Deploy PonsSniper to Robinhood Chain (chainId 4663). NOT run by tests or CI.
 *
 *   EXECUTOR_PRIVATE_KEY=0x…        deployer (pays gas; may be a burst key). Default: the first key of
 *                                   EXECUTOR_PRIVATE_KEYS (the sniper's env file, sourced as is)
 *   OWNER=0x…                       REQUIRED cold owner (sweeps, admin) — must differ from every hot key
 *   OPERATORS=0x…,0x…               exit key + burst keys (the addresses of the sniper's EXECUTOR_PRIVATE_KEYS).
 *                                   Default: every key of EXECUTOR_PRIVATE_KEYS (else the deployer)
 *   [MAX_QUOTE_IN_ETH=0.3]          per-snipe cap enforced on-chain (owner can change it). The default
 *                                   equals the preset default `sizing.maxEth`; the sniper clamps
 *                                   bankroll sizes to it anyway (NEW-6)
 *   [MAX_SPEND_PER_WINDOW_ETH=4×MAX_QUOTE_IN_ETH] [SPEND_WINDOW_SEC=3600]
 *                                   decaying buy budget (N4 / NEW-5: at most MAX_SPEND at once,
 *                                   refilling at MAX_SPEND / SPEND_WINDOW_SEC per second; bounds what a
 *                                   stolen operator key can lose via its own launches).
 *                                   SPEND_WINDOW_SEC must be ≥ 1; to turn the budget off the OWNER
 *                                   sends disableSpendLimit() after the deploy (explicit, NEW-5)
 *   [TREASURY=0x…]                  receiver of exit proceeds (default: the owner; printed as owner calldata)
 *   [FACTORY=0x7ed5…]               PonsV2LaunchFactory (default from @hood/core)
 *   [RPC_URL=https://rpc.mainnet.chain.robinhood.com] [DRY_RUN=1]
 *   [FUND_ETH=…]                    send this much ETH from the deployer to the contract after the
 *                                   deploy. No default: unset = no funding (fund from the cold owner)
 *   pnpm --filter @hood/contracts run deploy
 *
 * After the deploy the script reads back owner, operators[0], factory, arbBlockNumbers,
 * maxQuoteIn, maxSpendPerWindow and spendWindow and fails if any differs from what was asked.
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
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const sniperKeys = (process.env.EXECUTOR_PRIVATE_KEYS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean) as Hex[];
if (sniperKeys.some((k) => !KEY_RE.test(k))) throw new Error('EXECUTOR_PRIVATE_KEYS must be 0x + 64 hex keys');
const pk = (process.env.EXECUTOR_PRIVATE_KEY || sniperKeys[0]) as Hex | undefined;
if (!pk || !KEY_RE.test(pk)) throw new Error('EXECUTOR_PRIVATE_KEY or EXECUTOR_PRIVATE_KEYS (0x + 64 hex) required');

const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

const account = privateKeyToAccount(pk);
const owner = process.env.OWNER as Address | undefined;
if (!owner || !isAddress(owner)) throw new Error('OWNER (cold address) is required');
const defaultOperators = sniperKeys.length ? sniperKeys.map((k) => privateKeyToAccount(k).address).join(',') : account.address;
const operators = (process.env.OPERATORS ?? defaultOperators)
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
const maxQuoteIn = parseEther(process.env.MAX_QUOTE_IN_ETH ?? '0.3');
const maxSpend = process.env.MAX_SPEND_PER_WINDOW_ETH ? parseEther(process.env.MAX_SPEND_PER_WINDOW_ETH) : maxQuoteIn * 4n;
const spendWindow = Number(process.env.SPEND_WINDOW_SEC ?? '3600');
if (!Number.isInteger(spendWindow) || spendWindow < 1 || spendWindow > 2 ** 32 - 1)
  throw new Error('SPEND_WINDOW_SEC must be a uint32 ≥ 1 (the constructor refuses 0; the owner turns the budget off with disableSpendLimit())');
if (maxSpend < maxQuoteIn) throw new Error(`MAX_SPEND_PER_WINDOW_ETH must be ≥ MAX_QUOTE_IN_ETH (a smaller budget refuses every full-size snipe)`);
const fundEth = process.env.FUND_ETH; // no default: unset = the contract is funded later from the cold owner

const publicClient = createPublicClient({ chain: robinhood, transport: http(rpcUrl) });
const wallet = createWalletClient({ account, chain: robinhood, transport: http(rpcUrl) });

async function main(): Promise<void> {
  const chainId = await publicClient.getChainId();
  if (chainId !== 4663) throw new Error(`unexpected chainId ${chainId}`);
  const nonce = await publicClient.getTransactionCount({ address: account.address });
  const predicted = getContractAddress({ from: account.address, nonce: BigInt(nonce) });
  console.log(`deployer ${account.address} nonce ${nonce} → PonsSniper at ${predicted}`);
  console.log(`owner ${owner} operators ${operators.join(',')} factory ${factory} maxQuoteIn ${maxQuoteIn} spend budget ${maxSpend} per ${spendWindow}s`);
  if (process.env.DRY_RUN === '1') return;

  const hash = await wallet.deployContract({ abi: sniperAbi, bytecode: sniperBytecode, args: [owner!, operators[0]!, factory, maxQuoteIn, maxSpend, spendWindow] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`deploy failed: ${hash}`);
  const address = receipt.contractAddress;
  const [o, isOp, arb, f, mq, ms, sw] = await Promise.all([
    publicClient.readContract({ address, abi: sniperAbi, functionName: 'owner' }),
    publicClient.readContract({ address, abi: sniperAbi, functionName: 'operators', args: [operators[0]!] }),
    publicClient.readContract({ address, abi: sniperAbi, functionName: 'arbBlockNumbers' }),
    publicClient.readContract({ address, abi: sniperAbi, functionName: 'factory' }),
    publicClient.readContract({ address, abi: sniperAbi, functionName: 'maxQuoteIn' }),
    publicClient.readContract({ address, abi: sniperAbi, functionName: 'maxSpendPerWindow' }),
    publicClient.readContract({ address, abi: sniperAbi, functionName: 'spendWindow' }),
  ]);
  const failed = [
    o.toLowerCase() !== owner!.toLowerCase() && `owner ${o} ≠ ${owner}`,
    !isOp && `operators(${operators[0]}) is false`,
    !arb && 'arbBlockNumbers() is false (deadlines would use L1 block numbers)',
    f.toLowerCase() !== factory.toLowerCase() && `factory ${f} ≠ ${factory}`,
    BigInt(mq) !== maxQuoteIn && `maxQuoteIn ${mq} ≠ ${maxQuoteIn}`,
    BigInt(ms) !== maxSpend && `maxSpendPerWindow ${ms} ≠ ${maxSpend}`,
    Number(sw) !== spendWindow && `spendWindow ${sw} ≠ ${spendWindow}`,
  ].filter(Boolean);
  if (failed.length) throw new Error(`post-deploy check failed: ${failed.join('; ')}`);
  console.log(`verified: owner, operator ${operators[0]}, factory, arbBlockNumbers, maxQuoteIn ${mq}, spend budget ${ms} per ${sw}s`);

  for (const op of operators.slice(1)) {
    const data = encodeFunctionData({ abi: sniperAbi, functionName: 'setOperator', args: [op, true] });
    console.log(`owner must send: to=${address} data=${data}   # setOperator(${op}, true)`);
  }
  if (treasury) {
    const data = encodeFunctionData({ abi: sniperAbi, functionName: 'setTreasury', args: [treasury] });
    console.log(`owner must send: to=${address} data=${data}   # setTreasury(${treasury})`);
  }
  if (fundEth) {
    const tx = await wallet.sendTransaction({ to: address, value: parseEther(fundEth) });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`funded ${fundEth} ETH (${tx})`);
  } else console.log('not funded (FUND_ETH unset): send the working balance from the cold owner');
  console.log(`SNIPER_CONTRACT=${address.toLowerCase()}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
