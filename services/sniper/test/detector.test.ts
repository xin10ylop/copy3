import { createAddress, decodeFeedFrame, decodedTxFromRpc, parseTokenLaunchedLog, type FeedBlock } from '@hood/core';
import { describe, expect, it } from 'vitest';
import { LaunchDetector } from '../src/detector.js';
import { LAUNCH, emptyBlock, feedFrames, launchBlock, launchFixture, launchTx, tokenLaunchedLog } from './helpers/fixtures.js';

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
    const t = decodedTxFromRpc({ ...launchFixture.tx, hash: `0x${'66'.repeat(32)}`, input: '0x3cf28b5a' + '0'.repeat(64) });
    expect(d.isCandidate(t)).toBe(true);
    expect(await d.detect(emptyBlock(1, LAUNCH.ts, LAUNCH.ts * 1000, [t]))).toEqual([]);
    expect(launchTx().selector).toBe('0xf35abbcf');
  });
});
