import { PONS_V2, QUOTE_TOKENS, TOPICS, createAddress, decodeFeedFrame, decodedTxFromRpc, factoryAbi, parseTokenLaunchedLog, type FeedBlock, type RawLog } from '@hood/core';
import { encodeFunctionData, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { LaunchDetector, verifyLaunchReceipt } from '../src/detector.js';
import { LAUNCH, emptyBlock, feedFrames, launchBlock, launchFixture, launchReceipt, launchTx, tokenLaunchedLog } from './helpers/fixtures.js';

describe('LaunchDetector', () => {
  it('replays the 40 captured frames: no launches, prefilter allocates nothing', async () => {
    const d = new LaunchDetector({ maxLaunchAgeMs: Number.POSITIVE_INFINITY });
    const blocks: FeedBlock[] = feedFrames.flatMap((f) => decodeFeedFrame(JSON.stringify(f.frame), f.receivedAt));
    expect(blocks.length).toBe(39);
    const t0 = performance.now();
    let cands = 0;
    for (const b of blocks) for (const tx of b.txs) if (d.isCandidate(tx)) cands++;
    const us = ((performance.now() - t0) * 1000) / blocks.reduce((a, b) => a + b.txs.length, 0);
    expect(cands).toBe(0);
    for (const b of blocks) expect(await d.detect(b)).toEqual([]);
    expect(d.stats.launches).toBe(0);
    // eslint-disable-next-line no-console
    console.log(`[detector] prefilter ${us.toFixed(3)} µs/tx`);
  });

  it('detects the real launchToken tx from a FeedBlock built from the fixture fields', async () => {
    const d = new LaunchDetector();
    const b = launchBlock(LAUNCH.ts * 1000 + 120, [decodedTxFromRpc({ ...launchFixture.tx, hash: `0x${'11'.repeat(32)}`, to: '0x1111111111111111111111111111111111111111', input: '0xa9059cbb' })]);
    const [l, ...rest] = await d.detect(b);
    expect(rest).toEqual([]);
    expect(l).toBeDefined();
    expect(l!.txHash).toBe(LAUNCH.txHash);
    expect(l!.block).toBe(LAUNCH.block);
    expect(l!.ts).toBe(LAUNCH.ts);
    expect(l!.event).toMatchObject({
      name: 'SHIBA INU',
      symbol: 'SHIB',
      deployer: LAUNCH.deployer,
      txFrom: LAUNCH.deployer,
      creatorFeeRecipient: LAUNCH.creatorFeeRecipient,
      launchKind: 'launchToken',
      devBuyQuoteIn: 0n,
      launcher: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
    });
    expect(new Set(l!.event.exemptions)).toEqual(new Set([LAUNCH.deployer, LAUNCH.creatorFeeRecipient]));
    expect(l!.token).toBeUndefined(); // CREATE2 deployer: addresses come from the receipt/log
  });

  it('resolves token/curve from the TokenLaunched log (waiters wake up, log-before-feed works)', async () => {
    const d = new LaunchDetector();
    const [l] = await d.detect(launchBlock(LAUNCH.ts * 1000 + 50));
    const waiting = d.waitAddresses(l!, 1000);
    const parsed = parseTokenLaunchedLog(tokenLaunchedLog);
    d.resolve(parsed.txHash!, { token: parsed.token, curve: parsed.curve, source: 'log' });
    expect(await waiting).toEqual({ token: LAUNCH.token, curve: LAUNCH.curve, source: 'log' });
    expect(l!.event.token).toBe(LAUNCH.token);
    expect(l!.curve).toBe(LAUNCH.curve);

    // log first, feed later
    const d2 = new LaunchDetector();
    d2.resolve(LAUNCH.txHash, { token: LAUNCH.token, curve: LAUNCH.curve, source: 'log' });
    const [l2] = await d2.detect(launchBlock(LAUNCH.ts * 1000 + 50));
    expect(l2!.addressSource).toBe('log');
    expect(await d2.waitAddresses(l2!, 10)).toMatchObject({ token: LAUNCH.token });
  });

  it('waitAddresses times out with null', async () => {
    const d = new LaunchDetector();
    const [l] = await d.detect(launchBlock(LAUNCH.ts * 1000 + 50));
    expect(await d.waitAddresses(l!, 20)).toBeNull();
  });

  it('skips stale (replayed) launches', async () => {
    const d = new LaunchDetector({ maxLaunchAgeMs: 2500 });
    expect(await d.detect(launchBlock(LAUNCH.ts * 1000 + 10_000))).toEqual([]);
    expect(d.stats.stale).toBe(1);
  });

  it('nonce prediction: +2 per launch, reconciles, and disables itself on a CREATE2 deployer', async () => {
    const d = new LaunchDetector({ prediction: 'nonce' });
    d.seedNonce(1_431_817n);
    const [l] = await d.detect(launchBlock(LAUNCH.ts * 1000 + 50));
    expect(l!.addressSource).toBe('nonce');
    expect(l!.token).toBe(createAddress(d.launchDeployer, 1_431_817n));
    expect(l!.curve).toBe(createAddress(d.launchDeployer, 1_431_818n));
    expect(d.nonce).toBe(1_431_819n);
    // a correct prediction keeps the mode
    d.resolve(LAUNCH.txHash, { token: l!.token!, curve: l!.curve!, source: 'log' });
    expect(d.stats.predictedOk).toBe(1);
    // a drifted nonce is re-found by searching around the tracked value
    const tx2 = decodedTxFromRpc({ ...launchFixture.tx, hash: `0x${'22'.repeat(32)}` });
    const [l2] = await d.detect(emptyBlock(LAUNCH.block + 1, LAUNCH.ts, LAUNCH.ts * 1000 + 90, [tx2]));
    expect(l2!.token).toBe(createAddress(d.launchDeployer, 1_431_819n));
    d.resolve(tx2.hash, { token: createAddress(d.launchDeployer, 1_431_825n), curve: createAddress(d.launchDeployer, 1_431_826n), source: 'log' });
    expect(d.nonce).toBe(1_431_827n);
    expect(d.predictionMode).toBe('nonce');
    // the real (CREATE2) addresses match no nonce → two misses disable prediction
    for (const h of ['33', '44']) {
      const t = decodedTxFromRpc({ ...launchFixture.tx, hash: `0x${h.repeat(32)}` });
      await d.detect(emptyBlock(LAUNCH.block + 2, LAUNCH.ts, LAUNCH.ts * 1000 + 95, [t]));
      d.resolve(t.hash, { token: LAUNCH.token, curve: LAUNCH.curve, source: 'log' });
    }
    expect(d.predictionMode).toBe('none');
    const [l3] = await d.detect(emptyBlock(LAUNCH.block + 3, LAUNCH.ts, LAUNCH.ts * 1000 + 99, [decodedTxFromRpc({ ...launchFixture.tx, hash: `0x${'55'.repeat(32)}` })]));
    expect(l3!.token).toBeUndefined();
  });

  it('ignores non-launch calls to the factory', async () => {
    const d = new LaunchDetector();
    const t = decodedTxFromRpc({ ...launchFixture.tx, hash: `0x${'66'.repeat(32)}`, input: `0x3cf28b5a${'0'.repeat(64)}` });
    expect(d.isCandidate(t)).toBe(false); // to = factory but not a launch selector
    expect(await d.detect(emptyBlock(1, LAUNCH.ts, LAUNCH.ts * 1000, [t]))).toEqual([]);
    expect(launchTx().selector).toBe('0xf35abbcf');
  });
});

describe('H1: spoofed launches', () => {
  const ATTACKER_CONTRACT = '0x00000000000000000000000000000000000a77ac';
  const params = {
    name: 'SHIBA INU',
    symbol: 'SHIB',
    logo: '',
    description: '',
    socials: { x: '', telegram: '', website: '', discord: '', farcaster: '' },
    creatorFeeRecipient: ATTACKER_CONTRACT,
    creatorTaxBps: 0,
    buybackEnabled: false,
    salt1: `0x${'00'.repeat(32)}`,
    salt2: `0x${'00'.repeat(32)}`,
  } as const;
  const spoofTx = (to: string, hashByte: string) =>
    decodedTxFromRpc({
      ...launchFixture.tx,
      hash: `0x${hashByte.repeat(32)}`,
      from: '0x000000000000000000000000000000000000beef',
      to: to as `0x${string}`,
      value: 0n,
      input: encodeFunctionData({ abi: factoryAbi, functionName: 'launchTokenFor', args: [params, 0n, QUOTE_TOKENS.eth, LAUNCH.deployer, []] }),
    });

  it('PoC5: launchTokenFor calldata naming a followed deployer, sent to the attacker\'s own contract, is not a launch', async () => {
    const d = new LaunchDetector();
    const tx = spoofTx(ATTACKER_CONTRACT, 'a7');
    expect(d.isCandidate(tx)).toBe(false);
    expect(await d.detect(emptyBlock(LAUNCH.block, LAUNCH.ts, LAUNCH.ts * 1000 + 50, [tx]))).toEqual([]);
    // an explicitly whitelisted launcher contract is accepted
    const d2 = new LaunchDetector({ launchers: [ATTACKER_CONTRACT] });
    expect(d2.isCandidate(tx)).toBe(true);
  });

  it('a launch tx to the factory is only a hint: the receipt must show TokenLaunched from the factory with the same deployer', async () => {
    const d = new LaunchDetector();
    // the factory rejects a non-whitelisted launchTokenFor: the feed still shows the tx
    const [spoof] = await d.detect(emptyBlock(LAUNCH.block, LAUNCH.ts, LAUNCH.ts * 1000 + 50, [spoofTx(PONS_V2.factory, 'b8')]));
    expect(spoof!.event.deployer).toBe(LAUNCH.deployer); // calldata claims the followed deployer
    expect(verifyLaunchReceipt(launchReceipt({ status: 'reverted', logs: [] }), spoof!)).toMatchObject({ ok: false, spoof: true, reason: expect.stringMatching(/reverted/) });
    expect(verifyLaunchReceipt(launchReceipt({ logs: [] }), spoof!)).toMatchObject({ ok: false, spoof: true, reason: expect.stringMatching(/no TokenLaunched/) });
    // a real TokenLaunched for ANOTHER deployer (e.g. the attacker's own launch) never stands in
    const other: RawLog = { ...tokenLaunchedLog, topics: [...tokenLaunchedLog.topics.slice(0, 3), `0x${'0'.repeat(24)}${'be'.repeat(20)}`] };
    expect(verifyLaunchReceipt(launchReceipt({ logs: [other] }), spoof!)).toMatchObject({ ok: false, spoof: true, reason: expect.stringMatching(/≠/) });
    // a TokenLaunched-shaped log emitted by some other contract is ignored
    expect(verifyLaunchReceipt(launchReceipt({ logs: [{ ...tokenLaunchedLog, address: ATTACKER_CONTRACT }] }), spoof!)).toMatchObject({ ok: false, reason: expect.stringMatching(/no TokenLaunched/) });
    // the ws path cannot smuggle a mismatching deployer in either
    const waiting = d.waitAddresses(spoof!, 30);
    expect(d.resolve(spoof!.txHash, { token: LAUNCH.token, curve: LAUNCH.curve, source: 'log', deployer: '0x000000000000000000000000000000000000beef' })).toBeUndefined();
    expect(await waiting).toBeNull();
    expect(d.stats.deployerMismatch).toBe(1);
  });

  it('the real receipt confirms: token/curve/deployer from TokenLaunched, team wallets from the curve\'s SnipeTaxExempted logs', async () => {
    const d = new LaunchDetector();
    const [l] = await d.detect(launchBlock(LAUNCH.ts * 1000 + 50));
    const v = verifyLaunchReceipt(launchReceipt(), l!);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.confirmation).toMatchObject({ token: LAUNCH.token, curve: LAUNCH.curve, deployer: LAUNCH.deployer, block: LAUNCH.block });
    expect(new Set(v.confirmation.exemptions)).toEqual(new Set([LAUNCH.deployer, LAUNCH.creatorFeeRecipient]));
    // SnipeTaxExempted from another contract does not add team wallets; calldata extras do not either
    const fake: RawLog = { address: '0x1111111111111111111111111111111111111111', topics: [TOPICS.SnipeTaxExempted, `0x${'0'.repeat(24)}${'cd'.repeat(20)}`], data: '0x' };
    const l2 = { ...l!, event: { ...l!.event, exemptions: [...l!.event.exemptions, `0x${'ef'.repeat(20)}` as Hex] } };
    const v2 = verifyLaunchReceipt(launchReceipt({ logs: [...launchFixture.receipt.logs, fake] }), l2);
    expect(v2.ok && v2.confirmation.exemptions.length).toBe(2);
    // the receipt's block must be the feed's launch block (the burst is timed from it)
    expect(verifyLaunchReceipt(launchReceipt({ blockNumber: LAUNCH.block + 1 }), l!)).toMatchObject({ ok: false, spoof: false });
    expect(parseTokenLaunchedLog(tokenLaunchedLog).deployer).toBe(LAUNCH.deployer);
  });
});
