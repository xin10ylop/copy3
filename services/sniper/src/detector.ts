/**
 * LaunchDetector: feed block → Pons V2 launches (before execution results are known).
 *
 * Hot path: a synchronous prefilter on `tx.to ∈ {factory, launchAndBuyRouter}` or
 * `selector ∈ launch selectors` (no allocation for the ~99.9 % of txs that are not launches),
 * then ABI-decode + lazy sender recovery for the few candidates.
 *
 * Token/curve addresses: the TokenLaunched log (node ws) or the launch receipt resolves them
 * (`resolve()`), ~100-200 ms after the launch block. Optional nonce-based CREATE prediction
 * (`prediction: 'nonce'`, seeded from eth_getTransactionCount at startup, +2 per observed
 * launch, reconciled on every TokenLaunched log) is kept per the original design, but the
 * Pons V2 deployer was verified to use CREATE2 (packages/core/src/pons/addresses.ts), so it
 * disables itself after two mismatches.
 */
import {
  PONS_V2,
  SELECTORS,
  createAddress,
  launchEventFromCall,
  parseLaunchCall,
  predictLaunchAddresses,
  type LaunchCall,
} from '@hood/core';
import type { DecodedTx, FeedBlock } from '@hood/core';
import type { Address, Hex } from 'viem';
import type { DetectedLaunch } from './types.js';

export interface LaunchDetectorOptions {
  factory?: Address;
  router?: Address;
  launchDeployer?: Address;
  prediction?: 'none' | 'nonce';
  /** skip (but still account for) launches whose block arrived later than this (replays) */
  maxLaunchAgeMs?: number;
}

export interface ResolvedAddresses {
  token: Address;
  curve: Address;
  source: 'nonce' | 'log' | 'receipt' | 'fallback';
}

const LAUNCH_SELECTORS = new Set<string>([
  SELECTORS.launchToken3,
  SELECTORS.launchToken4,
  SELECTORS.launchTokenFor,
  SELECTORS.launchAndBuy,
]);

interface Waiter {
  resolve: (a: ResolvedAddresses | null) => void;
  timer: NodeJS.Timeout;
}

export class LaunchDetector {
  readonly factory: Address;
  readonly router: Address;
  readonly launchDeployer: Address;
  private prediction: 'none' | 'nonce';
  private readonly maxLaunchAgeMs: number;
  private deployerNonce: bigint | null = null;
  private mismatches = 0;
  /** txHash → launch awaiting addresses */
  private readonly launches = new Map<string, DetectedLaunch>();
  private readonly waiters = new Map<string, Waiter[]>();
  /** addresses that arrived before the feed tx was processed */
  private readonly early = new Map<string, ResolvedAddresses>();
  readonly stats = { candidates: 0, launches: 0, stale: 0, parseErrors: 0, predictedOk: 0, predictedBad: 0 };

  constructor(opts: LaunchDetectorOptions = {}) {
    this.factory = (opts.factory ?? PONS_V2.factory).toLowerCase() as Address;
    this.router = (opts.router ?? PONS_V2.launchAndBuyRouter).toLowerCase() as Address;
    this.launchDeployer = (opts.launchDeployer ?? PONS_V2.launchDeployer).toLowerCase() as Address;
    this.prediction = opts.prediction ?? 'none';
    this.maxLaunchAgeMs = opts.maxLaunchAgeMs ?? 2500;
  }

  get predictionMode(): 'none' | 'nonce' {
    return this.prediction;
  }

  /** Seed the deployer nonce (eth_getTransactionCount(launchDeployer, 'latest') at startup). */
  seedNonce(nonce: bigint | number): void {
    this.deployerNonce = BigInt(nonce);
  }

  get nonce(): bigint | null {
    return this.deployerNonce;
  }

  /** Synchronous prefilter (no allocation for non-launch txs). */
  isCandidate(tx: DecodedTx): boolean {
    return (
      tx.to === this.factory ||
      tx.to === this.router ||
      (tx.selector !== null && LAUNCH_SELECTORS.has(tx.selector))
    );
  }

  /** Decode every launch in a feed block. Senders are recovered only for launch txs. */
  async detect(block: FeedBlock): Promise<DetectedLaunch[]> {
    let cands: DecodedTx[] | undefined;
    for (const tx of block.txs) if (this.isCandidate(tx)) (cands ??= []).push(tx);
    if (!cands) return [];
    const stale = block.receivedAt - block.timestamp * 1000 > this.maxLaunchAgeMs;
    const out: DetectedLaunch[] = [];
    for (const tx of cands) {
      this.stats.candidates++;
      let call: LaunchCall | null;
      try {
        call = parseLaunchCall({ to: tx.to, input: tx.input, value: tx.value });
      } catch {
        this.stats.parseErrors++;
        continue;
      }
      if (!call) continue;
      const from = await tx.recoverFrom();
      const event = launchEventFromCall(call, { from, to: tx.to, hash: tx.hash, block: block.block, ts: block.timestamp });
      const launch: DetectedLaunch = {
        event,
        block: block.block,
        ts: block.timestamp,
        receivedAt: block.receivedAt,
        txHash: tx.hash,
        source: 'feed',
      };
      if (this.prediction === 'nonce' && this.deployerNonce !== null) {
        const p = predictLaunchAddresses(this.launchDeployer, this.deployerNonce);
        this.deployerNonce += 2n;
        launch.token = p.token;
        launch.curve = p.curve;
        launch.addressSource = 'nonce';
      }
      const early = this.early.get(tx.hash);
      if (early) {
        this.early.delete(tx.hash);
        this.apply(launch, early);
      }
      this.stats.launches++;
      if (stale) {
        this.stats.stale++;
        continue;
      }
      this.launches.set(tx.hash, launch);
      if (this.launches.size > 512) this.launches.delete(this.launches.keys().next().value!);
      out.push(launch);
    }
    return out;
  }

  private apply(l: DetectedLaunch, a: ResolvedAddresses): void {
    l.token = a.token;
    l.curve = a.curve;
    l.addressSource = a.source;
    l.event = { ...l.event, token: a.token, curve: a.curve };
  }

  /**
   * Confirm addresses from the TokenLaunched log / receipt (ground truth). Reconciles the
   * nonce predictor and wakes `waitAddresses` callers. Returns the launch if it was known.
   */
  resolve(txHash: Hex, addrs: ResolvedAddresses): DetectedLaunch | undefined {
    const key = txHash.toLowerCase();
    const l = this.launches.get(key);
    if (this.prediction === 'nonce' && addrs.source !== 'nonce') this.reconcileNonce(l, addrs);
    if (!l) {
      this.early.set(key, addrs);
      if (this.early.size > 256) this.early.delete(this.early.keys().next().value!);
    } else if (l.addressSource !== 'log' && l.addressSource !== 'receipt') {
      this.apply(l, addrs);
    }
    const ws = this.waiters.get(key);
    if (ws) {
      this.waiters.delete(key);
      for (const w of ws) {
        clearTimeout(w.timer);
        w.resolve(addrs);
      }
    }
    return l;
  }

  private reconcileNonce(l: DetectedLaunch | undefined, a: ResolvedAddresses): void {
    if (l?.addressSource === 'nonce' && l.token === a.token && l.curve === a.curve) {
      this.stats.predictedOk++;
      this.mismatches = 0;
      return;
    }
    this.stats.predictedBad++;
    // search near the tracked nonce for CREATE(deployer, n) == token
    const base = this.deployerNonce ?? 0n;
    for (let d = 0n; d <= 64n; d++) {
      for (const n of [base - d, base + d]) {
        if (n < 0n) continue;
        if (createAddress(this.launchDeployer, n) === a.token) {
          this.deployerNonce = n + 2n;
          this.mismatches = 0;
          return;
        }
      }
    }
    if (++this.mismatches >= 2) this.prediction = 'none'; // deployer is not plain-CREATE (CREATE2)
  }

  /**
   * Addresses for a launch: immediately if predicted/known, else when `resolve()` is called,
   * else null after `timeoutMs`. Callers using a nonce prediction should still treat a later
   * `resolve()` as authoritative.
   */
  waitAddresses(l: DetectedLaunch, timeoutMs: number): Promise<ResolvedAddresses | null> {
    if (l.token && l.curve && l.addressSource) return Promise.resolve({ token: l.token, curve: l.curve, source: l.addressSource });
    const key = l.txHash.toLowerCase();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const ws = this.waiters.get(key)?.filter((w) => w.timer !== timer);
        if (ws && ws.length) this.waiters.set(key, ws);
        else this.waiters.delete(key);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      const list = this.waiters.get(key) ?? [];
      list.push({ resolve, timer });
      this.waiters.set(key, list);
    });
  }

  /** Known launch by tx hash (feed-detected). */
  get(txHash: Hex): DetectedLaunch | undefined {
    return this.launches.get(txHash.toLowerCase());
  }
}
