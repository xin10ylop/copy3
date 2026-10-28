/**
 * Launch-address prediction (SPEC §1).
 *
 * `predictLaunchAddresses` implements the plain-CREATE formula
 * (keccak(rlp([deployer, nonce]))[12:]) via viem `getContractAddress`.
 *
 * IMPORTANT (verified live, see RESEARCH "Verification results"): the Pons V2
 * launch deployer does NOT use plain CREATE — it deploys token and curve with
 * CREATE2 (salted; the launch params carry salt1/salt2 bytes32). A brute-force
 * search over nonces 1..1.5M for the live deployer and factory reproduced none
 * of the measured TokenLaunched addresses, and the deployer bytecode contains a
 * CREATE2 (0xf5) opcode and a `predictLaunchAddresses(params)` selector.
 *
 * So nonce-based prediction is kept for completeness and for any future CREATE
 * deployer, but production code must take token/curve from the TokenLaunched
 * receipt (which arrives ~100-200 ms after the launch block — well inside the
 * 1-second snipe window) rather than predicting from the feed tx.
 */
import { getContractAddress } from 'viem';
import type { Address } from '../types.js';

export interface PredictedAddresses {
  token: Address;
  curve: Address;
}

/**
 * Predict token = CREATE(deployer, nonce) and curve = CREATE(deployer, nonce+1).
 * `nonce` is the deployer's nonce at the point it creates the token.
 */
export function predictLaunchAddresses(deployer: string, nonce: bigint | number): PredictedAddresses {
  const n = typeof nonce === 'bigint' ? nonce : BigInt(nonce);
  const token = getContractAddress({ from: deployer as `0x${string}`, nonce: n }).toLowerCase() as Address;
  const curve = getContractAddress({ from: deployer as `0x${string}`, nonce: n + 1n }).toLowerCase() as Address;
  return { token, curve };
}

/** A single CREATE address for a (deployer, nonce). */
export function createAddress(deployer: string, nonce: bigint | number): Address {
  const n = typeof nonce === 'bigint' ? nonce : BigInt(nonce);
  return getContractAddress({ from: deployer as `0x${string}`, nonce: n }).toLowerCase() as Address;
}
