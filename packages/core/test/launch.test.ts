import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseLaunchCall,
  launchKindOf,
  launchEventFromCall,
  exemptSetForLaunch,
  parseTokenLaunchedLog,
  parseCurveTradeLog,
  parseSnipeTaxChargedLog,
  parseSnipeTaxExemptedLog,
  parseCurveInitializedLog,
  type RawLog,
} from '../src/pons/launch.js';

const read = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'));
const launchTx = read('./fixtures/launch-tx.json');
const curveLogs = read('./fixtures/curve-logs.json') as RawLog[];
const tokenLaunchedLog = read('./fixtures/token-launched-log.json') as RawLog;

describe('parseLaunchCall (launchToken 3-arg fixture)', () => {
  const call = parseLaunchCall(launchTx.tx)!;

  it('decodes the SHIBA INU launch', () => {
    expect(call).not.toBeNull();
    expect(call.kind).toBe('launchToken');
    expect(call.selector).toBe('0xf35abbcf');
    expect(call.name).toBe('SHIBA INU');
    expect(call.symbol).toBe('SHIB');
    expect(call.creatorFeeRecipient).toBe('0x44e58c19c5d979ad4457075855acd88b93f5a49b');
    expect(call.pairToken).toBe('0x0000000000000000000000000000000000000000');
    expect(call.launchConfigId).toBe(0n);
    expect(call.creatorTaxBps).toBe(0);
    expect(call.exemptions).toEqual([]);
    expect(call.devBuyQuoteIn).toBe(0n);
    expect(call.deployer).toBeUndefined();
  });

  it('decodes socials and logo', () => {
    expect(call.logo).toContain('leverhood.xyz');
    // 5-string socials tuple, decoded positionally (field names in the ABI are nominal)
    expect(call.socials[0]).toBe('https://x.com/leverhood');
    expect(call.socials[3]).toBe('https://leverhood.xyz/');
    expect(call.socials).toHaveLength(5);
  });

  it('builds a LaunchEvent with the auto-exempt set', () => {
    const ev = launchEventFromCall(call, {
      from: launchTx.tx.from,
      to: launchTx.tx.to,
      hash: launchTx.tx.hash,
    });
    expect(ev.deployer).toBe('0x81eb508048220493549302d8ea5ef73a3fde1784');
    expect(ev.txFrom).toBe('0x81eb508048220493549302d8ea5ef73a3fde1784');
    expect(ev.launcher).toBe('0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e');
    // deployer ∪ creatorFeeRecipient (both auto-exempt on-chain → two SnipeTaxExempted logs)
    expect(new Set(ev.exemptions)).toEqual(
      new Set(['0x81eb508048220493549302d8ea5ef73a3fde1784', '0x44e58c19c5d979ad4457075855acd88b93f5a49b']),
    );
  });

  it('matches the two SnipeTaxExempted logs in the receipt', () => {
    const exemptLogs = (launchTx.receipt.logs as RawLog[])
      .filter((l) => l.topics[0] === '0xe4b7e48fbd47c2f602bacadee76ad33b16542ddb4997cfc0de04c311adcfa8c7')
      .map((l) => parseSnipeTaxExemptedLog(l).account);
    expect(new Set(exemptLogs)).toEqual(
      new Set(['0x81eb508048220493549302d8ea5ef73a3fde1784', '0x44e58c19c5d979ad4457075855acd88b93f5a49b']),
    );
  });
});

describe('launchKindOf', () => {
  it('maps every selector', () => {
    expect(launchKindOf({ input: '0xf35abbcf' })).toBe('launchToken');
    expect(launchKindOf({ input: '0xa72101af' })).toBe('launchToken');
    expect(launchKindOf({ input: '0xf85f8e41' })).toBe('launchAndBuy');
    expect(launchKindOf({ input: '0xd6a0eef5' })).toBe('launchTokenFor');
    expect(launchKindOf({ input: '0xdeadbeef' })).toBeNull();
    expect(parseLaunchCall({ input: '0xdeadbeef' })).toBeNull();
  });
});

describe('exemptSetForLaunch', () => {
  it('unions deployer, creatorFeeRecipient and explicit exemptions and drops zero', () => {
    const set = exemptSetForLaunch({
      deployer: '0xc92cc38d4403536ade5f2413cb785455d6b37cac',
      creatorFeeRecipient: '0x0000000000000000000000000000000000000000',
      exemptions: ['0x3e572ce00dd5ba0386d868fc42c33a9cd73ed91a', '0x9e3f51b4c11e415c0ccee32b9d7a7cc23932b7bf'],
    });
    expect(new Set(set)).toEqual(
      new Set([
        '0xc92cc38d4403536ade5f2413cb785455d6b37cac',
        '0x3e572ce00dd5ba0386d868fc42c33a9cd73ed91a',
        '0x9e3f51b4c11e415c0ccee32b9d7a7cc23932b7bf',
      ]),
    );
    expect(set).not.toContain('0x0000000000000000000000000000000000000000');
  });
});

describe('parseTokenLaunchedLog', () => {
  it('decodes the TokenLaunched log', () => {
    const p = parseTokenLaunchedLog(tokenLaunchedLog);
    expect(p.token).toBe('0xe9a2dc2003a9e7e2ca11f93b64c08b55a749215d');
    expect(p.curve).toBe('0xd30a935fddef5f5855519874ee2f4e7a7ea36821');
    expect(p.deployer).toBe('0x81eb508048220493549302d8ea5ef73a3fde1784');
    expect(p.pairToken).toBe('0x0000000000000000000000000000000000000000');
    expect(p.launchConfigId).toBe(0n);
    expect(p.graduationThreshold).toBe(4_200_000_000_000_000_000n);
    expect(p.block).toBe(0x5fa7429);
  });
});

describe('curve log parsers (curve-logs fixture)', () => {
  const buys = curveLogs.filter(
    (l) => l.topics[0] === '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  );
  const sells = curveLogs.filter(
    (l) => l.topics[0] === '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
  );

  it('decodes CurveBuy with creatorTax (aliased by tax)', () => {
    const b = parseCurveTradeLog(buys[0]!);
    expect(b.side).toBe('buy');
    expect(b.trader).toBe('0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc');
    expect(b.recipient).toBe('0xb81db28acaade5d04c2c14be798c15844166edda');
    expect(b.quote).toBe(6_600_000_000_000_000n);
    expect(b.tokens).toBe(3_874_217_774_441_546_983_339_796n);
    expect(b.fee).toBe(66_000_000_000_000n);
    expect(b.creatorTax).toBe(0n);
    expect(b.tax).toBe(b.creatorTax);
  });

  it('decodes CurveSell', () => {
    const s = parseCurveTradeLog(sells[0]!);
    expect(s.side).toBe('sell');
    expect(s.tokens).toBe(1_937_108_887_220_773_491_669_898n);
    expect(s.quote).toBe(3_290_971_753_203_601n);
    expect(s.creatorTax).toBe(0n);
  });

  it('decodes the curve Initialized log', () => {
    const init = curveLogs.find(
      (l) => l.topics[0] === '0x908408e307fc569b417f6cbec5d5a06f44a0a505ac0479b47d421a4b2fd6a1e6',
    )!;
    expect(parseCurveInitializedLog(init).token).toBe('0xe9a2dc2003a9e7e2ca11f93b64c08b55a749215d');
  });
});

describe('parseSnipeTaxChargedLog (amlil fixture)', () => {
  const amlil = read('./fixtures/amlil-trades.json');
  it('decodes the first taxed buyer snipe tax (6.18 %)', () => {
    const snipeLog = (amlil.snipe as RawLog[]).find(
      (l) => l.topics[1] === '0x000000000000000000000000c54d3914f91f984d61b63d491f38934c4e706b79',
    )!;
    const p = parseSnipeTaxChargedLog(snipeLog);
    expect(p.recipient).toBe('0xc54d3914f91f984d61b63d491f38934c4e706b79');
    expect(p.amount).toBe(2_163_000_000_000_000n); // 0.002163 ETH on 0.035 ETH = 6.18 %
    // 6.18 % of 0.035 ETH
    expect(Number(p.amount) / 0.035e18).toBeCloseTo(0.0618, 3);
  });
});
