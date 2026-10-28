import { describe, it, expect } from 'vitest';
import { toFunctionSelector, getAbiItem, type AbiFunction } from 'viem';
import { factoryAbi, routerAbi, curveAbi, tokenAbi, multicall3Abi, ponsEventsAbi } from '../src/abis/index.js';
import { SELECTORS, ERROR_SELECTORS } from '../src/addresses.js';

/**
 * Every function selector listed in RESEARCH §3 (as encoded in SELECTORS) must
 * match the viem-computed selector of its signature. This is the guard that
 * keeps the ABIs honest against the on-chain bytecode.
 */
const FUNCTION_SIGS: Record<keyof typeof SELECTORS, string> = {
  launchToken3:
    'function launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address)',
  launchToken4:
    'function launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,address[])',
  launchTokenFor:
    'function launchTokenFor((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,address,address[])',
  launchAndBuy:
    'function launchAndBuy((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,uint256,uint256,address,address[])',
  getLaunchedToken: 'function getLaunchedToken(address)',
  getLaunchConfig: 'function getLaunchConfig(uint256)',
  launchConfigCount: 'function launchConfigCount()',
  previewLaunchEconomics: 'function previewLaunchEconomics(uint256,address)',
  canLaunch: 'function canLaunch(address)',
  launchFee: 'function launchFee()',
  factorySnipeTaxStartBps: 'function snipeTaxStartBps()',
  factorySnipeTaxSeconds: 'function snipeTaxSeconds()',
  launchDeployer: 'function launchDeployer()',
  launchForwarder: 'function launchForwarder()',
  whitelistedLaunchers: 'function whitelistedLaunchers(address)',
  curveBuy: 'function buy(uint256,uint256,address)',
  curveSell: 'function sell(uint256,uint256,address)',
  currentSnipeTaxBps: 'function currentSnipeTaxBps(address)',
  snipeTaxExempt: 'function snipeTaxExempt(address)',
  exemptFromSnipeTax: 'function exemptFromSnipeTax(address)',
  getReserves: 'function getReserves()',
  quoteReserve: 'function quoteReserve()',
  tokenReserve: 'function tokenReserve()',
  realQuoteReserve: 'function realQuoteReserve()',
  phantomQuote: 'function phantomQuote()',
  launchedAt: 'function launchedAt()',
  graduated: 'function graduated()',
  readyToGraduate: 'function readyToGraduate()',
  feeBps: 'function feeBps()',
  creatorTaxBps: 'function creatorTaxBps()',
  maxInternalPriceImpactBps: 'function maxInternalPriceImpactBps()',
  launchSupply: 'function launchSupply()',
  sellableTokens: 'function sellableTokens()',
  reservedTokens: 'function reservedTokens()',
  graduationThreshold: 'function graduationThreshold()',
  token: 'function token()',
  pairToken: 'function pairToken()',
  isNativeQuote: 'function isNativeQuote()',
  deployer: 'function deployer()',
  factory: 'function factory()',
};

const ERROR_SIGS: Record<keyof typeof ERROR_SELECTORS, string> = {
  SlippageExceeded: 'error SlippageExceeded(uint256,uint256)',
  ZeroAmount: 'error ZeroAmount()',
  AlreadyGraduated: 'error AlreadyGraduated()',
  InvalidLaunchEconomics: 'error InvalidLaunchEconomics()',
};

describe('RESEARCH §3 selectors', () => {
  it('every function selector matches toFunctionSelector', () => {
    for (const [key, sig] of Object.entries(FUNCTION_SIGS)) {
      expect(toFunctionSelector(sig), `${key}: ${sig}`).toBe(SELECTORS[key as keyof typeof SELECTORS]);
    }
  });

  it('every custom-error selector matches', () => {
    for (const [key, sig] of Object.entries(ERROR_SIGS)) {
      // error selectors use the same keccak-of-signature[:4] scheme as functions
      expect(toFunctionSelector(sig.replace('error ', 'function ')), key).toBe(
        ERROR_SELECTORS[key as keyof typeof ERROR_SELECTORS],
      );
    }
  });
});

describe('parsed ABIs expose the RESEARCH surface', () => {
  function selOf(abi: readonly unknown[], name: string, args?: number): string {
    const fns = (abi as readonly AbiFunction[]).filter((i) => i.type === 'function' && i.name === name);
    const fn = args === undefined ? fns[0] : fns.find((f) => f.inputs.length === args);
    if (!fn) throw new Error(`missing ${name}${args === undefined ? '' : `/${args}`}`);
    return toFunctionSelector(fn);
  }

  it('curve ABI has buy/sell with the verified selectors', () => {
    expect(selOf(curveAbi, 'buy')).toBe(SELECTORS.curveBuy);
    expect(selOf(curveAbi, 'sell')).toBe(SELECTORS.curveSell);
    expect(selOf(curveAbi, 'getReserves')).toBe(SELECTORS.getReserves);
    expect(selOf(curveAbi, 'currentSnipeTaxBps')).toBe(SELECTORS.currentSnipeTaxBps);
  });

  it('factory ABI has overloaded launchToken (3 and 4 arg) and launchTokenFor', () => {
    expect(selOf(factoryAbi, 'launchToken', 3)).toBe(SELECTORS.launchToken3);
    expect(selOf(factoryAbi, 'launchToken', 4)).toBe(SELECTORS.launchToken4);
    expect(selOf(factoryAbi, 'launchTokenFor', 5)).toBe(SELECTORS.launchTokenFor);
  });

  it('router ABI has launchAndBuy with the verified selector', () => {
    expect(selOf(routerAbi, 'launchAndBuy')).toBe(SELECTORS.launchAndBuy);
  });

  it('curve ABI carries all four custom errors', () => {
    const errorNames = new Set(
      (curveAbi as readonly { type: string; name?: string }[])
        .filter((i) => i.type === 'error')
        .map((i) => i.name),
    );
    for (const name of Object.keys(ERROR_SELECTORS)) expect(errorNames.has(name), name).toBe(true);
  });

  it('token ABI has ERC20 + Pons extensions', () => {
    for (const fn of ['balanceOf', 'transfer', 'curve', 'deployer', 'launchFactory', 'getTokenInfo']) {
      expect(getAbiItem({ abi: tokenAbi as never, name: fn } as never), fn).toBeDefined();
    }
  });

  it('events ABI covers the core topics', () => {
    const names = new Set(
      (ponsEventsAbi as readonly { type: string; name?: string }[]).filter((i) => i.type === 'event').map((i) => i.name),
    );
    for (const ev of ['TokenLaunched', 'CurveBuy', 'CurveSell', 'SnipeTaxCharged', 'SnipeTaxExempted']) {
      expect(names.has(ev), ev).toBe(true);
    }
  });

  it('multicall3 ABI has aggregate3', () => {
    expect(getAbiItem({ abi: multicall3Abi as never, name: 'aggregate3' } as never)).toBeDefined();
  });
});
