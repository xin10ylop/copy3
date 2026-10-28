/** Robinhood Chain (chainId 4663) + Pons V2 addresses. All lower-case. Source: docs/RESEARCH.md §3 */
export const CHAIN_ID = 4663 as const;
export const PUBLIC_RPC_HTTP = 'https://rpc.mainnet.chain.robinhood.com';
export const FEED_URL = 'wss://feed.mainnet.chain.robinhood.com';
export const FEED_URL_DELAYED = 'wss://delayed-feed.mainnet.chain.robinhood.com';

export const PONS_V2 = {
  factory: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  launchAndBuyRouter: '0xe33e9e479df8802cb0866d5d05258bec4cf62948',
  launchDeployer: '0x3711cea4feade896c913c68f01eda97cb06d1a42',
  memeHook: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
  locker: '0x267444d099b10fb5ed7c3cc7b7c767adca574952',
  graduationExecutor: '0xc7819b64a1daecd7ec19856d026cb14efbd89046',
  feeEscrow: '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e',
  buybackVault: '0x42df2a798f82289e177311362e8f5ccc45c1219c',
  graduationGuard: '0xf5695117b99b6f6401e67d4195bd653628176c6c',
  uniswapV4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  v1Factory: '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb',
  tradeRouterProxy: '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc',
} as const;

/** Canonical multicall3 (verified deployed on this chain 2026-10-28, codeLen 3808). */
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

export const QUOTE_TOKENS = {
  eth: '0x0000000000000000000000000000000000000000',
  usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  cbbtc: '0xcec185eb182c47d1ba1efc84e6959e18cd620be4',
} as const;

/** Live factory params measured 2026-10-28 (read them on-chain at startup; these are defaults). */
export const SNIPE_TAX_START_BPS = 9900;
export const SNIPE_TAX_SECONDS = 3;
export const LAUNCH_SUPPLY = 1_000_000_000n * 10n ** 18n;
export const LAUNCH_FEE_WEI = 500_000_000_000_000n; // 0.0005 ETH
export const CURVE_FEE_BPS = 100;

/**
 * Function selectors from RESEARCH §3. Every entry is asserted against
 * `toFunctionSelector(signature)` in test/abis.test.ts; a drift fails the build.
 */
export const SELECTORS = {
  // factory launch entrypoints
  launchToken3: '0xf35abbcf',
  launchToken4: '0xa72101af',
  launchTokenFor: '0xd6a0eef5',
  launchAndBuy: '0xf85f8e41',
  // factory views
  getLaunchedToken: '0x3cf28b5a',
  getLaunchConfig: '0x1cad862d',
  launchConfigCount: '0xae72d871',
  previewLaunchEconomics: '0xf718b78c',
  canLaunch: '0x58373f04',
  launchFee: '0xcf3cf573',
  factorySnipeTaxStartBps: '0x50e25ac2',
  factorySnipeTaxSeconds: '0x6783774b',
  launchDeployer: '0x858f5964',
  launchForwarder: '0x9b924452',
  whitelistedLaunchers: '0xda3eda65',
  // curve trading
  curveBuy: '0x59a87bc1',
  curveSell: '0xd04c6983',
  currentSnipeTaxBps: '0xd7e1ef39',
  snipeTaxExempt: '0xd44bdfe7',
  exemptFromSnipeTax: '0x31ff7f22',
  // curve reserves / views
  getReserves: '0x0902f1ac',
  quoteReserve: '0x9da771f4',
  tokenReserve: '0xcbcb3171',
  realQuoteReserve: '0x4f1f58fd',
  phantomQuote: '0xc57eadfc',
  launchedAt: '0xbf56b371',
  graduated: '0xe7c2b772',
  readyToGraduate: '0xc68360a5',
  feeBps: '0x24a9d853',
  creatorTaxBps: '0xc1bb8901',
  maxInternalPriceImpactBps: '0x90addc1e',
  launchSupply: '0x3f7ed6b7',
  sellableTokens: '0x808bcddc',
  reservedTokens: '0x15a55347',
  graduationThreshold: '0x8b0bc501',
  token: '0xfc0c546a',
  pairToken: '0x3de35b79',
  isNativeQuote: '0xdc08e094',
  deployer: '0xd5f39488',
  factory: '0xc45a0155',
} as const;

/** Custom-error selectors from RESEARCH §3 (verified in test/abis.test.ts). */
export const ERROR_SELECTORS = {
  SlippageExceeded: '0x71c4efed',
  ZeroAmount: '0x1f2a2005',
  AlreadyGraduated: '0xe6a0d45f',
  InvalidLaunchEconomics: '0xbc0ecfe3',
} as const;

export const TOPICS = {
  TokenLaunched: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
  RouterLaunched: '0xdcacba5e347ae7abd91cb519eb877af8fa7774e347b85dd3ddcd24a2ba8cdf37',
  CurveBuy: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  CurveSell: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
  SnipeTaxCharged: '0x3bc39a5562b28f5fe8f36cecabfbaa12bb969acf05717994709225fc412a9934',
  SnipeTaxExempted: '0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7',
  CurveInitialized: '0x908408e307fc569b417f6cbec5d5a06f44a0a505ac0479b47d421a4b2fd6a1e6',
  CurveCompleted: '0xf8d37a90738ae063b8b8058b66f5880cf3cf7ab0c5d4fa78219696591dfbfb67',
  LaunchSwept: '0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4',
  PoolGraduated: '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259',
  PoolRegistered: '0x01bf263a1db1652580721573296e1a1fa70b3d4c87f61d02a69c4e1109d2d573',
  Erc20Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
} as const;
