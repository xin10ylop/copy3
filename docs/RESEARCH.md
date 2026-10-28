# Verified research: Robinhood Chain + Pons V2 (collected 2026-10-28)

Everything below was either measured live against the chain during this session or
taken from primary docs. Items marked (measured) came from RPC/feed calls; (docs)
from Robinhood / Arbitrum / Bitquery / Pons documentation.

## 1. The chain is Robinhood Chain, not Solana

The video's addresses are `0x…` EVM addresses, amounts are in ETH, the explorer is
"rh-scan"/Blockscout and the launchpad is Pons V2. That is **Robinhood Chain**:

| Item | Value |
|---|---|
| Chain ID | 4663 (`0x1237`) (measured) |
| Stack | Arbitrum Nitro / Orbit, ArbOS 61, image `offchainlabs/nitro-node:v3.11.2-3599aca` (docs) |
| Block cadence | ~100 ms; measured 9.8 blocks/s under load, blocks only when there are txs (measured) |
| Gas | native ETH; `eth_gasPrice` ≈ 20.6M wei = 0.0206 gwei (measured). A 200k-gas tx costs ≈ 0.000004 ETH |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` (rate limited, no SLA) |
| Sequencer feed | `wss://feed.mainnet.chain.robinhood.com` (public, no auth, no subscribe message needed) (measured) |
| Delayed feed | `wss://delayed-feed.mainnet.chain.robinhood.com` (~500 ms behind) (docs) |
| Explorer | `https://robinhoodchain.blockscout.com` (official; Cloudflare-blocks scripted HTTP - 403 for curl/fetch). Alternatives reported: `4663scan.io`, Arkham, `robin.etherscan.io` |
| Sequencer location | AWS us-east-2 (Ohio). Submission RTT measured by Glassnode: Ohio 3 ms, Virginia 18 ms, Chicago 27 ms, London 91 ms, Tokyo 140 ms |
| Ordering | First-come-first-served at the sequencer. No priority-fee ordering. Queue position == physical proximity + send timing |
| Node config files | `https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/chain-node-configs/robinhood-chain-info.json` and `robinhood-genesis.json` |
| Node hardware (docs) | 8+ cores, 64 GB RAM min / 128 GB rec., local NVMe sized 2x chain + 20%; pruned snapshots at `https://snapshot-explorer.arbitrum.io/?chain=Robinhood+Chain` (`--init.url`) |
| Node needs | an Ethereum L1 execution RPC **and** an L1 beacon endpoint (blob reads). Ports 8547 http / 8548 ws |
| Node flags (docs) | `--chain.info-files=/home/nitro/config/robinhood-chain-info.json --init.genesis-json-file=/home/nitro/config/robinhood-genesis.json --parent-chain.connection.url=<L1> --parent-chain.blob-client.beacon-url=<beacon> --node.feed.input.url=wss://feed.mainnet.chain.robinhood.com --node.feed.input.secondary-url=wss://delayed-feed.mainnet.chain.robinhood.com --execution.forwarding-target=https://rpc.mainnet.chain.robinhood.com --http.addr=0.0.0.0 --http.port=8547 --http.api=net,web3,eth,debug,arb --ws.addr=0.0.0.0 --ws.port=8548 --ws.api=net,web3,eth,debug` |

Latency consequence: a hot path in Chicago is ~24 ms behind an Ohio competitor on
every send. Blocks are 100 ms, so that is a quarter of a block of disadvantage.
See ARCHITECTURE.md for how we deal with it (executor in Ohio, bulk in Chicago).

## 2. Sequencer feed format (measured + Arbitrum docs)

One websocket text frame per L2 block:

```json
{"version":1,"messages":[{"sequenceNumber":100302108,
  "message":{"message":{"header":{"kind":3,"sender":"0xa4b0…","blockNumber":26293203,"timestamp":1793214255,"requestId":null,"baseFeeL1":null},
                        "l2Msg":"<base64>"},
             "delayedMessagesRead":…},
  "signature":null,"blockMetadata":null}]}
```

* `sequenceNumber` **equals the L2 block number** on Robinhood Chain (genesis offset 0) (measured: seq 100302108 while `eth_blockNumber` was ≈100302xxx).
* `header.timestamp` is the block timestamp in whole seconds. This is the value the
  Pons snipe tax is computed from.
* `header.blockNumber` is the **L1** block, ignore it.
* `l2Msg` (base64 → bytes): first byte is the L2 message kind. Observed kind `0x03`
  (`L2MessageKind_Batch`). A batch is a sequence of `[uint64 BE length][sub-message]`;
  each sub-message starts with its own kind byte, observed `0x04`
  (`L2MessageKind_SignedTx`) followed by a standard typed signed tx
  (`0x02 f9…` = EIP-1559 RLP, chainId 0x1237). Kinds (nitro `arbos/parse_l2.go`):
  0 UnsignedUserTx, 1 ContractTx, 2 NonmutatingCall, 3 Batch, 4 SignedTx,
  6 Heartbeat (deprecated), 7 SignedCompressedTx.
* Feed open from a non-Ohio location took ~430 ms; 12 blocks arrived in ~1.1 s.

## 3. Pons V2 launchpad (contracts on Robinhood Chain)

Pons V2 went live 2026-08-01. Each launch mints 1,000,000,000 tokens (18 dec) into
its own bonding-curve contract; 5/7 of supply is sold on the curve, 2/7 is swept to
seed a Uniswap v4 pool at graduation (threshold 4.2 ETH for ETH-quoted launches).
Launch fee 0.0005 ETH (measured in launch tx value). Curve trade fee 100 bps
(`feeBps()`), optional creator tax (`creatorTaxBps()`, ≤ `maxCreatorTaxBps`).

### Addresses

| Contract | Address |
|---|---|
| `PonsV2LaunchFactory` | `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e` |
| `PonsV2LaunchAndBuy` (router: launch + dev buy atomically) | `0xe33e9e479df8802cb0866d5d05258bec4cf62948` |
| Launch deployer (CREATEs token + curve; nonce was 1,431,817) | `0x3711cea4feade896c913c68f01eda97cb06d1a42` |
| `PonsV2MemeHook` (v4 hook) | `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044` |
| `PonsV2LaunchLocker` | `0x267444d099b10fb5ed7c3cc7b7c767adca574952` |
| Graduation executor | `0xc7819b64a1daecd7ec19856d026cb14efbd89046` |
| Fee escrow | `0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e` |
| Buyback vault | `0x42df2a798f82289e177311362e8f5ccc45c1219c` |
| Graduation guard | `0xf5695117b99b6f6401e67d4195bd653628176c6c` |
| Uniswap v4 PoolManager (chain-wide) | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| V1 factory (superseded, no longer launching) | `0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb` |
| USDG (6 dec) / cbBTC (8 dec) quote tokens | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` / `0xcec185eb182c47d1ba1efc84e6959e18cd620be4` |
| Trade router used by the Pons UI / aggregators (ERC-1967 proxy, selector `0x4d819a2a`) | `0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc` |
| Observed launch tool (socials "leverhood.xyz") | n/a, launches come as plain `launchToken` from the dev EOA |

Launch volume: 63 launches in a ~34 minute window (≈2/min) (measured).

### Snipe tax (the whole game)

Factory getters (measured live): `snipeTaxStartBps() = 9900`, `snipeTaxSeconds() = 3`.
Formula (Bitquery decode of the contract):

```
elapsed      = block.timestamp - curve.launchedAt()        // whole seconds
snipeTaxBps  = snipeTaxStartBps >> ((elapsed * 14) / snipeTaxSeconds)
```

| elapsed (s) | shift | tax |
|---|---|---|
| 0 (same second as launch) | 0 | **99.00 %** |
| 1 | 4 | **6.18 %** (618 bps) |
| 2 | 9 | 0.19 % (19 bps) |
| ≥3 | 14 | 0 |

This matches the video exactly ("6-7 % at 1 second, ~0 by 5 seconds"). The tax is
charged on the quote-in and emitted as `SnipeTaxCharged`. Sells are never taxed.

Exemptions: a launch emitted two `SnipeTaxExempted(address)` events even with the
plain 3-arg `launchToken` → the **deployer and the `creatorFeeRecipient` are auto-
exempt**; the 4-arg variant adds an explicit `address[] snipeTaxExemptions`. The
curve exposes `snipeTaxExempt(address)` and `currentSnipeTaxBps(address)` (view).
Exempt wallets are the "dev team" wallets from the video that buy in the launch
second with 0 tax; they can never be beaten, only recognised.

### Curve contract (one per token) – function selectors (measured from bytecode)

```
buy(uint256,uint256,address)        0x59a87bc1   payable for native quote (msg.value = quoteIn)
sell(uint256,uint256,address)       0xd04c6983
currentSnipeTaxBps(address)         0xd7e1ef39   view
snipeTaxExempt(address)             0xd44bdfe7   view
exemptFromSnipeTax(address)         0x31ff7f22   (deployer-only setter)
getReserves()                       0x0902f1ac
quoteReserve() 0x9da771f4  tokenReserve() 0xcbcb3171  realQuoteReserve() 0x4f1f58fd  phantomQuote() 0xc57eadfc
launchedAt()   0xbf56b371  graduated() 0xe7c2b772   readyToGraduate() 0xc68360a5
feeBps()       0x24a9d853  creatorTaxBps() 0xc1bb8901  maxInternalPriceImpactBps() 0x90addc1e
launchSupply() 0x3f7ed6b7  sellableTokens() 0x808bcddc reservedTokens() 0x15a55347 graduationThreshold() 0x8b0bc501
token() 0xfc0c546a  pairToken() 0x3de35b79  isNativeQuote() 0xdc08e094  deployer() 0xd5f39488  factory() 0xc45a0155
errors: SlippageExceeded(uint256,uint256) 0x71c4efed, ZeroAmount() 0x1f2a2005, AlreadyGraduated() 0xe6a0d45f, InvalidLaunchEconomics() 0xbc0ecfe3
```

Exact parameter order of `buy`/`sell` must be confirmed by `eth_call` simulation on a
live curve before real money (see SPEC.md task list): most likely
`buy(uint256 quoteIn, uint256 minTokensOut, address recipient)` and
`sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)`.
`maxInternalPriceImpactBps()` suggests a per-trade price-impact cap – large buys may
need to be split.

Pricing is constant-product with a virtual ("phantom") quote reserve:
`price = quoteReserve / tokenReserve`, `mcap = price * 1e9`. `realQuoteReserve` is
the ETH actually held; `phantomQuote` the virtual offset.

### Factory – key functions (measured from bytecode)

```
launchToken((string name,string symbol,string logo,string description,(string,string,string,string,string) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 salt1,bytes32 salt2) params, uint256 launchConfigId, address pairToken)                        0xf35abbcf
launchToken(params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions)                                                                                                  0xa72101af
launchTokenFor(params, uint256 launchConfigId, address pairToken, address deployer, address[] snipeTaxExemptions)   0xd6a0eef5   (called by router / whitelisted launchers)
getLaunchedToken(address) 0x3cf28b5a   getLaunchConfig(uint256) 0x1cad862d   launchConfigCount() 0xae72d871
previewLaunchEconomics(uint256,address) 0xf718b78c   canLaunch(address) 0x58373f04   launchFee() 0xcf3cf573
snipeTaxStartBps() 0x50e25ac2   snipeTaxSeconds() 0x6783774b   launchDeployer() 0x858f5964   launchForwarder() 0x9b924452
whitelistedLaunchers(address) 0xda3eda65
```

Router: `launchAndBuy(params, uint256 launchConfigId, address pairToken, uint256 buyQuoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions)` `0xf85f8e41` → "dev bought at launch".

Observed `launchToken` tx: `value = 0.0005 ETH`, gas used 3.63M, 6 logs:
token `Transfer` (mint to curve), curve `Initialized(token)`, 2× `SnipeTaxExempted`,
one log from `0x31ea5b453a6cd60f36203830de046ff32dec2cdb` (fee escrow-ish), factory `TokenLaunched`.

### Events (topic0)

```
Factory TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)
        0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607
Router  Launched(token, curve, deployer, pairToken, launchConfigId, graduationThreshold)  0xdcacba5e347ae7abd91cb519eb877af8fa7774e347b85dd3ddcd24a2ba8cdf37
Curve   CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)
        0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455
Curve   CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)
        0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df
Curve   SnipeTaxCharged(address indexed recipient, uint256 amount)   0x3bc39a5562b28f5fe8f36cecabfbaa12bb969acf05717994709225fc412a9934
Curve   SnipeTaxExempted(address)  (address is indexed: 2 topics, empty data)  0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7
Curve   Initialized(address token)  0x908408e307fc569b417f6cbec5d5a06f44a0a505ac0479b47d421a4b2fd6a1e6
Curve   CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut)  0xf8d37a90738ae063b8b8058b66f5880cf3cf7ab0c5d4fa78219696591dfbfb67
Factory LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut)  0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4
Factory PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)  0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259
Hook    PoolRegistered(bytes32 indexed poolId, address memecoin, address quoteToken, address creator)  0x01bf263a1db1652580721573296e1a1fa70b3d4c87f61d02a69c4e1109d2d573
```

Note on `CurveBuy.buyer`: when a user trades through the trade router
(`0x6505…`), `buyer` is the router and `recipient` is the user. `tx.from` is the
real EOA. Always attribute by `recipient` (and `tx.from`), never by `buyer`.

Observed real trade through the router: 0.00667 ETH buy → 3.87M tokens, fee
0.000066, tax 0 (bought 25 s after launch).

## 4. Address prediction

The launch deployer `0x3711…` had nonce 1,431,817 - consistent with plain `CREATE`
(two contracts per launch ≈ 716k launches). If token = CREATE(deployer, n) and
curve = CREATE(deployer, n+1), both addresses are computable from the feed before
the launch block is executed. Must be verified with a keccak implementation
(see SPEC.md). Not required for correctness: the `TokenLaunched` receipt arrives
within ~100-200 ms, far inside the 1-second window.

## 5. Tools the video used (for feature parity)

* **TradeWiz** (Telegram bot) "dev sniping" task: tag/category, target wallet, stop
  after N, first-buy-only, token cap, launchpad = Pons V2, drawdown (trailing stop:
  activate at +100 %, exit on 25 % pullback), take profits (e.g. 150 % all out, or
  100-125 % + 200 %), stop loss 40 %, timeout, buy amount 0.07 ETH, slippage
  80-90 %, gas 10, "tax protection global 10 %" (= max snipe tax tolerated, i.e.
  buy ~1 s after launch paying ~6 %).
* **Packet Tracker** (Telegram bot): watches a funder wallet (direct or
  "contract"/disperse mode) for transfers in [min,max] ETH to fresh wallets, then
  clones a TradeWiz preset onto the funded wallet as a snipe task.
* **GMGN** charts, Blockscout explorer, Claude with a "play finder" skill producing
  a report + CSV (CA, dev wallet, name, start mcap, ATH mcap, launch time in 2 TZs,
  tax-free badge, first taxed buyer + entry mcap, peak % at 2/5/10/30/60 s from the
  first taxed buyer's entry).

## 6. Cherry Servers (API `https://api.cherryservers.com/v1/plans`, public)

Chicago, US bare-metal plans relevant to a Robinhood Chain node (monthly USD, measured 2026-10-28):

| Plan | CPU | RAM | Storage | NIC | $/mo |
|---|---|---|---|---|---|
| AMD Ryzen 9700X | 8c | 96 GB | 2x1 TB NVMe | 10 Gbps | 189 |
| AMD Ryzen 9900X | 12c | 96 GB | 2x1 TB NVMe | 10 Gbps | 196 |
| AMD Ryzen 7950X | 16c | 128 GB | 2x1 TB NVMe | 3 Gbps | 199 |
| AMD Ryzen 9950X | 16c | 128 GB | 2x1 TB NVMe | 10 Gbps | 349 |
| AMD EPYC 9124P | 16c | 64 GB | 2x1 TB NVMe | 10 Gbps | 359 |
| AMD EPYC 9254P | 24c | 192 GB | 2x1 TB NVMe | 10 Gbps | 409 |
| AMD EPYC 9354P | 32c | 192 GB | 2x1 TB NVMe | 10 Gbps | 549 |
| AMD EPYC 9375F | 32c | 384 GB | 2x1 TB + 2x4 TB NVMe | 3 Gbps | 989 |
| AMD EPYC 9654P | 96c | 768 GB | 2x4 TB NVMe | 3 Gbps | 999 |
| Cloud VDS / Premium VDS (EPYC 9554P) 2-8 vCPU | | 16-64 GB | 100-400 GB NVMe | 1 Gbps | 69-149 |

Also present: Cloud VPS from $3/mo, custom servers with more NVMe, Terraform/Ansible/CLI
support, 100 TB egress included.

## 7. Open items to verify before real money (owned by the build tasks)

1. `buy`/`sell` parameter order on the curve (eth_call simulation).
2. Whether the curve rejects contract callers (`msg.sender != tx.origin`) – decides
   whether the `PonsSniper` helper contract can be used. Our simulation plan: eth_call
   `buy` from a contract address via state override.
3. `maxInternalPriceImpactBps` value and the buy-size it implies.
4. CREATE address prediction (token = CREATE(deployer, n), curve = n+1).
5. Chain data size for a pruned full node (snapshot explorer).
6. Actual feed→local and local→sequencer latencies from the chosen hosts.
