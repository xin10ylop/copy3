/**
 * LaunchDetector: feed block → Pons V2 launches (before execution results are known).
 *
 * Hot path: a synchronous prefilter on `tx.to ∈ {factory, launchAndBuyRouter, configured
 * launchers}` AND `selector ∈ launch selectors` (no allocation for the ~99.9 % of txs that are
 * not launches), then ABI-decode + lazy sender recovery for the few candidates. A launch-shaped
 * calldata sent anywhere else is ignored: anyone can put `launchTokenFor(…, deployer = <a wallet
 * we follow>)` into a tx to their own contract (reviewer PoC5). Even a launch tx to the factory is
 * only a hint until its receipt shows a TokenLaunched from the factory with the same deployer.
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
  TOPICS,
  createAddress,
  launchEventFromCall,
  parseLaunchCall,
  parseTokenLaunchedLog,
  predictLaunchAddresses,
  type LaunchCall,
} from '@hood/core';
import type { DecodedTx, FeedBlock } from '@hood/core';
import type { Address, Hex } from 'viem';
import type { ReceiptLite } from './chain.js';
import type { DetectedLaunch, LaunchConfirmation } from './types.js';

export interface LaunchDetectorOptions {
  factory?: Address;
  router?: Address;
  launchDeployer?: Address;
  prediction?: 'none' | 'nonce';
  /** extra contracts allowed to launch (whitelisted launchers); default none */
  launchers?: readonly string[];
  /** skip (but still account for) launches whose block arrived later than this (replays) */
  maxLaunchAgeMs?: number;
}

export interface ResolvedAddresses {
  token: Address;
  curve: Address;
  source: 'nonce' | 'log' | 'receipt' | 'fallback';
  /** TokenLaunched.deployer (must equal the launch event's deployer) */
  deployer?: Address;
  /** block of the TokenLaunched log (ws) */
  block?: number;
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
  private readonly launchers: Set<string>;
  private prediction: 'none' | 'nonce';
  private readonly maxLaunchAgeMs: number;
  private deployerNonce: bigint | null = null;
  private mismatches = 0;
  /** txHash → launch awaiting addresses */
  private readonly launches = new Map<string, DetectedLaunch>();
  private readonly waiters = new Map<string, Waiter[]>();
  /** addresses that arrived before the feed tx was processed */
  private readonly early = new Map<string, ResolvedAddresses>();
  /** N16: TokenLaunched logs pushed by the node (ws), per launch tx */
  private readonly launchLogs = new Map<string, { token: Address; curve: Address; deployer: Address; block: number | undefined }[]>();
  readonly stats = { candidates: 0, launches: 0, stale: 0, parseErrors: 0, predictedOk: 0, predictedBad: 0, deployerMismatch: 0 };

  constructor(opts: LaunchDetectorOptions = {}) {
    this.factory = (opts.factory ?? PONS_V2.factory).toLowerCase() as Address;
    this.router = (opts.router ?? PONS_V2.launchAndBuyRouter).toLowerCase() as Address;
    this.launchDeployer = (opts.launchDeployer ?? PONS_V2.launchDeployer).toLowerCase() as Address;
    this.launchers = new Set([this.factory, this.router, ...(opts.launchers ?? []).map((a) => a.toLowerCase())]);
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

  /** Synchronous prefilter: launch selector sent to the factory/router/whitelisted launcher. */
  isCandidate(tx: DecodedTx): boolean {
    return tx.to !== null && tx.selector !== null && this.launchers.has(tx.to) && LAUNCH_SELECTORS.has(tx.selector);
  }

  isLauncher(to: string | null | undefined): boolean {
    return !!to && this.launchers.has(to.toLowerCase());
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
        if (!early.deployer || early.deployer.toLowerCase() === launch.event.deployer.toLowerCase()) this.apply(launch, early);
        else this.stats.deployerMismatch++;
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
    if (addrs.source === 'log' && addrs.deployer) this.recordLaunchLog(key, addrs);
    if (l && addrs.deployer && addrs.deployer.toLowerCase() !== l.event.deployer.toLowerCase()) {
      // a TokenLaunched for a different deployer in this tx: never let it stand in for ours
      this.stats.deployerMismatch++;
      return undefined;
    }
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

  private recordLaunchLog(key: string, a: ResolvedAddresses): void {
    const list = this.launchLogs.get(key) ?? [];
    if (!list.some((x) => x.token === a.token.toLowerCase() && x.curve === a.curve.toLowerCase())) {
      list.push({ token: a.token.toLowerCase() as Address, curve: a.curve.toLowerCase() as Address, deployer: a.deployer!.toLowerCase() as Address, block: a.block });
    }
    this.launchLogs.set(key, list);
    if (this.launchLogs.size > 512) this.launchLogs.delete(this.launchLogs.keys().next().value!);
  }

  /**
   * N16: confirmation from the node's TokenLaunched ws log (arrives with the block, before a
   * receipt poll sees it) — same semantics as `verifyLaunchReceipt`: exactly one factory
   * TokenLaunched for the matched deployer, in the launch block. Only for txs sent straight to
   * the factory / router (one launch per call; a whitelisted launcher contract could batch, so
   * those wait for the receipt). Team wallets are the calldata set, which for these entrypoints is
   * exactly what the factory exempts; the receipt still verifies them in the background.
   */
  logConfirmation(l: DetectedLaunch): LaunchConfirmation | null {
    const to = l.event.launcher?.toLowerCase();
    if (to !== this.factory && to !== this.router) return null;
    const mine = (this.launchLogs.get(l.txHash.toLowerCase()) ?? []).filter((x) => x.deployer === l.event.deployer.toLowerCase());
    if (mine.length !== 1) return null; // none yet, or ambiguous: the receipt decides
    const m = mine[0]!;
    if (m.block !== undefined && m.block !== l.block) return null;
    return { token: m.token, curve: m.curve, deployer: m.deployer, exemptions: l.event.exemptions.map((x) => x.toLowerCase() as Address), block: l.block };
  }

  /** Known launch by tx hash (feed-detected). */
  get(txHash: Hex): DetectedLaunch | undefined {
    return this.launches.get(txHash.toLowerCase());
  }
}

export type ReceiptVerdict =
  | { ok: true; confirmation: LaunchConfirmation; notes: string[]; /** N16: from the ws log, receipt still pending */ viaLog?: boolean }
  | { ok: false; reason: string; /** the receipt contradicts the feed tx (spoof / wrong deployer) */ spoof: boolean };

const topicAddr = (t: string | undefined): Address => `0x${(t ?? '').slice(26)}`.toLowerCase() as Address;

/**
 * H1: the launch receipt is the only ground truth. Before anything is signed it must show a
 * successful tx with exactly one factory `TokenLaunched` whose `deployer` equals the deployer the
 * rules matched on (calldata / tx signer). Token, curve and the team (exempt) wallets are taken
 * from the receipt: `SnipeTaxExempted(account)` logs emitted by that curve.
 */
export function verifyLaunchReceipt(r: ReceiptLite, l: DetectedLaunch, factory: string = PONS_V2.factory): ReceiptVerdict {
  if (r.status !== 'success') return { ok: false, reason: `launch tx ${r.transactionHash} reverted`, spoof: true };
  const f = factory.toLowerCase();
  const launched = r.logs
    .filter((x) => x.address.toLowerCase() === f && x.topics[0] === TOPICS.TokenLaunched)
    .flatMap((x) => {
      try {
        return [parseTokenLaunchedLog(x)];
      } catch {
        return [];
      }
    });
  const want = l.event.deployer.toLowerCase();
  const mine = launched.filter((x) => x.deployer.toLowerCase() === want);
  if (mine.length === 0) {
    return launched.length === 0
      ? { ok: false, reason: 'receipt has no TokenLaunched from the factory (not a real launch)', spoof: true }
      : { ok: false, reason: `TokenLaunched.deployer ${launched.map((x) => x.deployer).join(',')} ≠ ${want} (spoofed deployer)`, spoof: true };
  }
  if (mine.length > 1) return { ok: false, reason: `ambiguous: ${mine.length} TokenLaunched for ${want} in one tx`, spoof: false };
  const tl = mine[0]!;
  const notes: string[] = [];
  if (r.blockNumber !== l.block) return { ok: false, reason: `receipt block ${r.blockNumber} ≠ launch block ${l.block}`, spoof: false };
  const exempt = new Set<Address>();
  for (const x of r.logs) {
    if (x.address.toLowerCase() === tl.curve && x.topics[0] === TOPICS.SnipeTaxExempted) exempt.add(topicAddr(x.topics[1]));
  }
  let exemptions = [...exempt];
  if (exemptions.length === 0) {
    exemptions = l.event.exemptions.map((a) => a.toLowerCase() as Address);
    notes.push('receipt had no SnipeTaxExempted logs; exemptions from calldata');
  }
  return {
    ok: true,
    confirmation: { token: tl.token as Address, curve: tl.curve as Address, deployer: tl.deployer as Address, exemptions, block: r.blockNumber },
    notes,
  };
}
