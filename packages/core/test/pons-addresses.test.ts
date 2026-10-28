import { describe, it, expect } from 'vitest';
import { predictLaunchAddresses, createAddress } from '../src/pons/addresses.js';

describe('predictLaunchAddresses (CREATE formula)', () => {
  it('computes token = CREATE(deployer, n), curve = CREATE(deployer, n+1)', () => {
    const deployer = '0x3711cea4feade896c913c68f01eda97cb06d1a42';
    const { token, curve } = predictLaunchAddresses(deployer, 1000n);
    expect(token).toBe(createAddress(deployer, 1000n));
    expect(curve).toBe(createAddress(deployer, 1001n));
    expect(token).toMatch(/^0x[0-9a-f]{40}$/u);
    expect(curve).toMatch(/^0x[0-9a-f]{40}$/u);
    expect(token).not.toBe(curve);
  });

  it('matches a known viem CREATE vector', () => {
    // CREATE(0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0, 0) is a documented viem fixture
    expect(createAddress('0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0', 0)).toBe(
      '0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d',
    );
  });

  it('accepts bigint and number nonces equivalently', () => {
    const d = '0x3711cea4feade896c913c68f01eda97cb06d1a42';
    expect(createAddress(d, 5)).toBe(createAddress(d, 5n));
  });
});
