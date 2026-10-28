# Worked example on real chain data: "Amlil" (the video's Amlo play)

Token `0xa7a7c2f7cea8f9bb3b5b85802f0cd844fa9b7586` (AMLIL), curve
`0xe2df162de883b0fb133f0f67466423d8d6533be2`, deployer
`0xc92cc38d4403536ade5f2413cb785455d6b37cac`, launched 2026-10-23 12:28:15 UTC
(block ≈ 95,940,695). Fixture: `packages/core/test/fixtures/amlil-trades.json`.

What the chain shows (all measured):

| Fact | Value |
|---|---|
| Snipe-tax exemptions emitted at launch | deployer + `0x3e572ce0…` + `0x9e3f51b4…` (the "dev team") |
| Dev's own buy | none (plain `launchToken`) |
| Team buys in the launch second (+0 s, block 95,940,700) | 0.1924 ETH → 100M tokens and 0.1877 ETH → 80M tokens (0.38 ETH, 18 % of supply), snipe tax 0, creator tax 2 % |
| Team wallet `0xc95b258a…` today | nonce 2, balance 0.000025 ETH (it only ever received gas money, as the video said) |
| First taxed buyer | `0xc54d3914…` at +1 s (block 95,940,704), 0.035 ETH, **snipe tax 0.002163 ETH = 6.18 %** (formula confirmed) |
| Retail entry avg price | 2.79e-9 ETH/token (≈ 2.8 ETH mcap) |
| Peaks from that entry (avg trade price) | +44 % @2 s, +222 % @5 s, +222 % @10 s, +377 % @30 s |
| How the team exited | **no curve sells from exempt wallets**. Between +6 s and +10 s they transferred the 180M tokens in 13 batches to `0xa98da960…`, which sold on the curve. 125 buys (6.05 ETH) vs 79 sells (3.44 ETH) in the first two minutes |

Consequences baked into the design:

1. `CurveBuy.tax` is the **creator tax**. The snipe tax is a separate
   `SnipeTaxCharged(recipient, amount)` log in the same tx. "First taxed buyer"
   = first buy whose tx carries `SnipeTaxCharged` (equivalently: recipient not in
   the exemption set).
2. The dump signal is an ERC-20 `Transfer` **out of an exempt wallet** to a
   non-curve address, not a `CurveSell` by the exempt wallet. The position
   manager must exit on that transfer (it precedes the sells by ~1 block) and
   the indexer must attribute the receiving wallet's sells to the operator.
3. Our target is to be `0xc54d3914…`: first in the first block of launch+1 s.
   That wallet was 4 blocks (~400 ms) after the team buys.
