/**
 * Deploy PonsSniper to Robinhood Chain (chainId 4663). NOT run by tests or CI.
 *
 *   EXECUTOR_PRIVATE_KEY=0x…  [RPC_URL=https://rpc.mainnet.chain.robinhood.com]
 *   [OWNER=0x… (default: deployer)] [OPERATOR=0x… (default: deployer)] [FUND_ETH=0.2] [DRY_RUN=1]
 *   pnpm --filter @hood/contracts deploy
 *
 * Prints the contract address; put it in SNIPER_CONTRACT for services/sniper.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getContractAddress,
  http,
  isAddress,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sniperAbi, sniperBytecode } from '../src/index.js';

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
const owner = (process.env.OWNER ?? account.address) as Address;
const operator = (process.env.OPERATOR ?? account.address) as Address;
if (!isAddress(owner) || !isAddress(operator)) throw new Error('OWNER/OPERATOR must be addresses');

const publicClient = createPublicClient({ chain: robinhood, transport: http(rpcUrl) });
const wallet = createWalletClient({ account, chain: robinhood, transport: http(rpcUrl) });

async function main(): Promise<void> {
  const chainId = await publicClient.getChainId();
  if (chainId !== 4663) throw new Error(`unexpected chainId ${chainId}`);
  const nonce = await publicClient.getTransactionCount({ address: account.address });
  const predicted = getContractAddress({ from: account.address, nonce: BigInt(nonce) });
  console.log(`deployer ${account.address} nonce ${nonce} → PonsSniper at ${predicted}`);
  console.log(`owner ${owner} operator ${operator}`);
  if (process.env.DRY_RUN === '1') return;

  const hash = await wallet.deployContract({ abi: sniperAbi, bytecode: sniperBytecode, args: [owner, operator] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`deploy failed: ${hash}`);
  const address = receipt.contractAddress;
  const [o, isOp, arb] = await Promise.all([
    publicClient.readContract({ address, abi: sniperAbi, functionName: 'owner' }),
    publicClient.readContract({ address, abi: sniperAbi, functionName: 'operators', args: [operator] }),
    publicClient.readContract({ address, abi: sniperAbi, functionName: 'arbBlockNumbers' }),
  ]);
  if (o.toLowerCase() !== owner.toLowerCase() || !isOp || !arb) throw new Error('post-deploy check failed');

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
