/**
 * LIVE=1 verification (SPEC §8 / RESEARCH §4): does CREATE(deployer, nonce)
 * predict the launched token/curve addresses?
 *
 * Fetches the launch deployer's current nonce (latest only — non-archive node)
 * and the most recent TokenLaunched events, then checks whether token/curve
 * equal CREATE(deployer, nonce+offset) for any small offset. The offline
 * brute-force (nonces 1..1.5M) already found no match, confirming CREATE2 use;
 * this test documents that on live data and never fails the suite on the
 * expected negative result (it asserts the search ran, and logs the outcome).
 */
import { describe, it, expect } from 'vitest';
import { rpc, hex } from './rpc.js';
import { PONS_V2 } from '../../src/addresses.js';
import { createAddress } from '../../src/pons/addresses.js';

const LIVE = process.env.LIVE === '1';

describe.skipIf(!LIVE)('live CREATE address prediction', () => {
  it('checks whether CREATE(deployer, nonce±k) reproduces recent launch addresses', async () => {
    const deployer = PONS_V2.launchDeployer;
    const nonce = BigInt(await rpc<string>('eth_getTransactionCount', [deployer, 'latest']));
    const bn = BigInt(await rpc<string>('eth_blockNumber', []));
    const logs = await rpc<{ topics: string[]; blockNumber: string }[]>('eth_getLogs', [
      {
        fromBlock: hex(bn - 5000n),
        toBlock: 'latest',
        address: PONS_V2.factory,
        topics: ['0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607'],
      },
    ]);
    const recent = logs.slice(-3).map((l) => ({
      token: ('0x' + l.topics[1]!.slice(26)).toLowerCase(),
      curve: ('0x' + l.topics[2]!.slice(26)).toLowerCase(),
      block: Number(BigInt(l.blockNumber)),
    }));

    // candidate CREATE addresses around the current nonce
    const candidates = new Map<string, string>();
    for (let k = -12n; k <= 2n; k++) {
      const n = nonce + k;
      if (n < 0n) continue;
      candidates.set(createAddress(deployer, n), `nonce${k >= 0n ? '+' : ''}${k}`);
    }
    const matches = recent.flatMap((r) =>
      [
        ['token', r.token] as const,
        ['curve', r.curve] as const,
      ]
        .filter(([, a]) => candidates.has(a))
        .map(([role, a]) => ({ role, addr: a, offset: candidates.get(a) })),
    );

    console.log('[§4] deployer nonce =', nonce.toString(), 'recent launches =', recent, 'CREATE matches =', matches);
    // Expected: zero matches → the deployer uses CREATE2, not plain CREATE.
    // Assert only that the search executed over real data.
    expect(recent.length).toBeGreaterThan(0);
    if (matches.length === 0) {
      console.log('[§4] CONFIRMED: CREATE(deployer, nonce) does NOT predict launch addresses → CREATE2 (salted).');
    } else {
      console.log('[§4] UNEXPECTED: CREATE prediction matched', matches);
    }
  }, 120_000);
});
