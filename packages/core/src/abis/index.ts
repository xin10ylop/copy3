/**
 * viem human-readable ABIs for Pons V2 on Robinhood Chain.
 *
 * Every function signature here is pinned to a selector verified on-chain
 * (RESEARCH §3 + the live-measured bytecode selector table). The matching
 * `toFunctionSelector` unit test (test/abis.test.ts) asserts each selector,
 * so an edit that changes a signature will fail loudly.
 *
 * Human-readable ABIs are parsed once with viem `parseAbi`; the parsed objects
 * (not the string arrays) are what the rest of the codebase imports.
 */
import { parseAbi } from 'viem';

/**
 * PonsV2 launch params struct (shared by all four launch entrypoints).
 * Layout verified from the live factory bytecode signature table:
 *   launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address)
 */
const LAUNCH_PARAMS_STRUCT =
  'struct LaunchParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 salt1; bytes32 salt2; }';
const SOCIALS_STRUCT = 'struct Socials { string x; string telegram; string website; string discord; string farcaster; }';

/**
 * Factory `getLaunchedToken(address)` returns a stored launch record. The field
 * layout is inferred from the live 15-word response (addresses first, then
 * launchConfigId, graduationThreshold, creatorTaxBps, flags). Selector depends
 * only on the input type (`address`), so the test is unaffected by the return
 * shape; semantics of the trailing fields are marked inferred in RESEARCH.
 */
const LAUNCH_INFO_STRUCT =
  'struct LaunchInfo { address token; address curve; address deployer; address creatorFeeRecipient; uint256 launchConfigId; uint256 graduationThreshold; uint256 creatorTaxBps; uint256 f7; uint256 f8; uint256 f9; uint256 f10; uint256 f11; uint256 f12; uint256 f13; bool f14; }';

/** `getLaunchConfig(uint256)` / `addLaunchConfig` tuple layout (verified via addLaunchConfig signature). */
const LAUNCH_CONFIG_STRUCT =
  'struct LaunchConfig { uint256 launchSupply; uint256 feeBps; uint256 virtualQuote; uint256 graduationThreshold; uint24 field5; int24 creatorTaxCapOrTick; bool nativeQuote; }';

/** PonsV2LaunchFactory (0x7ed598bc…). */
export const factoryAbi = parseAbi([
  SOCIALS_STRUCT,
  LAUNCH_PARAMS_STRUCT,
  LAUNCH_INFO_STRUCT,
  LAUNCH_CONFIG_STRUCT,
  // --- launch entrypoints ---
  'function launchToken(LaunchParams params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)',
  'function launchToken(LaunchParams params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions) payable returns (address token, address curve)',
  'function launchTokenFor(LaunchParams params, uint256 launchConfigId, address pairToken, address deployer, address[] snipeTaxExemptions) payable returns (address token, address curve)',
  // --- views ---
  'function getLaunchedToken(address token) view returns (LaunchInfo)',
  'function getLaunchConfig(uint256 id) view returns (LaunchConfig)',
  'function launchConfigCount() view returns (uint256)',
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
  'function snipeTaxStartBps() view returns (uint256)',
  'function snipeTaxSeconds() view returns (uint256)',
  'function launchDeployer() view returns (address)',
  'function launchForwarder() view returns (address)',
  'function launchFee() view returns (uint256)',
  'function maxCreatorTaxBps() view returns (uint256)',
  'function canLaunch(address launcher) view returns (bool)',
  'function launchEnabled() view returns (bool)',
  'function whitelistedLaunchers(address launcher) view returns (bool)',
  'function memeHook() view returns (address)',
  'function locker() view returns (address)',
  'function feeEscrow() view returns (address)',
  'function graduationExecutor() view returns (address)',
  'function graduationGuard() view returns (address)',
  'function buybackVault() view returns (address)',
  'function poolManager() view returns (address)',
  'function positionManager() view returns (address)',
  'function owner() view returns (address)',
  // --- events ---
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
  'event LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut)',
  'event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)',
]);

/**
 * PonsV2LaunchAndBuy router / launch-forwarder (0xe33e9e47…).
 * The forwarder's own deployed bytecode exposes only Ownable + factory() (it
 * forwards `launchAndBuy` through its fallback to the factory's launchTokenFor);
 * the `launchAndBuy` signature below is the documented router entrypoint and its
 * selector (0xf85f8e41) is verified in the test.
 */
export const routerAbi = parseAbi([
  SOCIALS_STRUCT,
  LAUNCH_PARAMS_STRUCT,
  'function launchAndBuy(LaunchParams params, uint256 launchConfigId, address pairToken, uint256 buyQuoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)',
  'function factory() view returns (address)',
  'function owner() view returns (address)',
  'function rescue(address token, address to)',
  'event Launched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
]);

/** Per-token bonding curve (one deployed per launch). */
export const curveAbi = parseAbi([
  // --- trading ---
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
  // --- snipe tax ---
  'function currentSnipeTaxBps(address account) view returns (uint256)',
  'function snipeTaxExempt(address account) view returns (bool)',
  'function exemptFromSnipeTax(address account)',
  'function snipeTaxStartBps() view returns (uint256)',
  'function snipeTaxSeconds() view returns (uint256)',
  // --- reserves / pricing ---
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function quoteReserve() view returns (uint256)',
  'function tokenReserve() view returns (uint256)',
  'function realQuoteReserve() view returns (uint256)',
  'function phantomQuote() view returns (uint256)',
  // --- state / economics ---
  'function launchedAt() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function readyToGraduate() view returns (bool)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function maxInternalPriceImpactBps() view returns (uint256)',
  'function launchSupply() view returns (uint256)',
  'function sellableTokens() view returns (uint256)',
  'function reservedTokens() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function token() view returns (address)',
  'function pairToken() view returns (address)',
  'function isNativeQuote() view returns (bool)',
  'function deployer() view returns (address)',
  'function factory() view returns (address)',
  'function buybackEnabled() view returns (bool)',
  'function protocolFeeShareBps() view returns (uint256)',
  'function feeEscrow() view returns (address)',
  // --- events ---
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
  'event SnipeTaxCharged(address indexed recipient, uint256 amount)',
  'event SnipeTaxExempted(address indexed account)',
  'event Initialized(address token)',
  'event CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut)',
  // --- custom errors ---
  'error SlippageExceeded(uint256 amountOut, uint256 minOut)',
  'error ZeroAmount()',
  'error AlreadyGraduated()',
  'error InvalidLaunchEconomics()',
  'error NativeValueMismatch(uint256 sent, uint256 expected)',
]);

/** Launch token (ERC20 + Pons extensions). */
export const tokenAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  // Pons extensions
  'function curve() view returns (address)',
  'function deployer() view returns (address)',
  'function launchFactory() view returns (address)',
  'function getTokenInfo() view returns (address deployer, string name, string symbol, string logo, string description, string[5] socials)',
  'function logo() view returns (string)',
  'function description() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);

/**
 * Event-only ABI: all Pons V2 log signatures in one object, for topic-filtered
 * `eth_getLogs`/feed decoding without caring which contract emitted them.
 */
export const ponsEventsAbi = parseAbi([
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
  'event Launched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
  'event SnipeTaxCharged(address indexed recipient, uint256 amount)',
  'event SnipeTaxExempted(address indexed account)',
  'event Initialized(address token)',
  'event CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut)',
  'event LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut)',
  'event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)',
  'event PoolRegistered(bytes32 indexed poolId, address memecoin, address quoteToken, address creator)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/**
 * PonsSniper helper contract (our own; see contracts/ and ARCHITECTURE §3).
 * ABI defined here so @hood/core consumers can encode burst calls without the
 * contract being deployed yet. Signatures are our design, not on-chain-verified.
 */
export const sniperAbi = parseAbi([
  'function snipe(address curve, address token, uint256 quoteIn, uint256 minTokensOut, uint256 maxTaxBps, uint256 deadlineBlock) payable',
  'function exit(address curve, address token, uint256 tokensIn, uint256 minQuoteOut)',
  'function bought(address token) view returns (bool)',
  'function sweep(address token, address to)',
  'function owner() view returns (address)',
  'event Sniped(address indexed token, address indexed curve, uint256 quoteIn, uint256 tokensOut)',
  'event Exited(address indexed token, address indexed curve, uint256 tokensIn, uint256 quoteOut)',
  'error AlreadyBought()',
  'error TaxTooHigh(uint256 current, uint256 max)',
  'error DeadlinePassed()',
]);

/** Multicall3 (canonical address 0xcA11…CA11; presence verified live — see RESEARCH). */
export const multicall3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getBlockNumber() view returns (uint256 blockNumber)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);
