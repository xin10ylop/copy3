/**
 * Message builders (Telegram HTML). Pure: everything they need comes in as arguments, so the
 * notifier and command tests can assert on the exact text.
 */
import { InlineKeyboard } from 'grammy';
import { PlayTriggerSchema, PresetSchema, type PlayTrigger, type Preset } from '@hood/core';
import {
  escapeHtml,
  fmtBps,
  fmtDuration,
  fmtEth,
  fmtMcap,
  fmtPct,
  fmtTime,
  fmtTokens,
  fmtUsd,
  Links,
  mcapEthFromPrice,
  shortAddr,
  truncate,
  weiToEth,
} from './format.js';
import { presetLines } from './preset.js';
import {
  reviewStatus,
  type ArmedRow,
  type EventRow,
  type KillState,
  type PlayRow,
  type PnlBucket,
  type PnlSummary,
  type SnipeRow,
  type StatusSnapshot,
} from './store.js';
import type { AgentRunSummary } from './ports.js';

export interface FormatCtx {
  links: Links;
  ethUsd: number | null;
  tz: string;
  now: Date;
}

const b = (s: string): string => `<b>${escapeHtml(s)}</b>`;
const code = (s: string): string => `<code>${escapeHtml(s)}</code>`;
const modeTag = (mode: 'live' | 'paper'): string => (mode === 'live' ? '[LIVE]' : '[PAPER]');
const usdOf = (eth: number | null, ctx: FormatCtx): string => (eth === null || ctx.ethUsd === null ? '' : ` (${fmtUsd(eth * ctx.ethUsd, { signed: eth < 0 })})`);
const usdSigned = (eth: number, ctx: FormatCtx): string => (ctx.ethUsd === null ? '' : ` (${fmtUsd(eth * ctx.ethUsd, { signed: true })})`);
const secondsBetween = (a: Date | null, b2: Date | null): number | null => (a && b2 ? (b2.getTime() - a.getTime()) / 1000 : null);

// ---------------------------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------------------------

export const COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'status', description: 'feed, node, kill switch, positions, daily PnL' },
  { command: 'play', description: '<ca> run the play finder on a coin (report + CSV)' },
  { command: 'scout', description: '[minutes] [minPeak10%] scan recent runners for new operators' },
  { command: 'plays', description: 'list plays' },
  { command: 'play_on', description: '<id> enable (approve) a play' },
  { command: 'play_off', description: '<id> disable a play' },
  { command: 'watch', description: '<funder> <min> <max> [fresh|any] [name] funding-trail watch' },
  { command: 'armed', description: 'armed candidate wallets' },
  { command: 'positions', description: 'open positions' },
  { command: 'pnl', description: '[days] realized PnL' },
  { command: 'preset', description: '<playId> key=value… edit a play preset' },
  { command: 'backtest', description: '<playId> backtest a play on indexed history' },
  { command: 'kill', description: '[reason] global kill switch ON' },
  { command: 'resume', description: 'kill switch OFF' },
  { command: 'help', description: 'commands and examples' },
];

export function helpText(): string {
  return [
    b('HoodSniper'),
    '',
    ...COMMANDS.map((c) => `/${c.command} ${escapeHtml(c.description)}`),
    '',
    b('Examples'),
    code('/play 0x7c3a…'),
    code('/watch 0xfunder… 0.057 0.174 fresh "Amlil operator"'),
    code('/preset 3 buyEth=0.05 maxTaxBps=700 trailing.activatePct=80 tp=100:50,200:100'),
    code('/preset 3 trailing=off timeoutSec=none exitIfExemptSellsPct=none'),
    '',
    'Preset keys: buyEth maxTaxBps slippageBps burst.startMs burst.spacingMs burst.count gasLimit maxFeeGwei priorityFeeGwei stopAfter firstBuyOnly tokenCap takeProfits trailing.activatePct trailing.dropPct stopLossPct timeoutSec minQuoteReserveEth maxEntryMcapEth abortIfExemptSellInLaunchBlock exitIfExemptSellsPct',
    'Aliases: buy tax slippage sl tp timeout trail.',
    '<code>off</code>/<code>none</code> turns off <code>trailing</code>, <code>timeoutSec</code> and <code>exitIfExemptSellsPct</code> (stored as null). Setting trailing.activatePct/dropPct turns trailing back on from the default 50/20. On other keys <code>none</code> removes the key, so the default applies.',
    'Defaults: buy 0.07 ETH, tax ≤ 10 % (maxTaxBps ≤ 5000), no fixed TP, trailing +50 %/-20 %, SL 40 %, timeout 60 s, exit on the first team outflow (exitIfExemptSellsPct=0).',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Plays
// ---------------------------------------------------------------------------------------------

export function triggerSummary(raw: unknown, links: Links): string {
  const parsed = PlayTriggerSchema.safeParse(raw ?? {});
  if (!parsed.success) return 'trigger: (invalid)';
  const t: PlayTrigger = parsed.data;
  const parts: string[] = [];
  if (t.armedWallet) {
    const a = t.armedWallet;
    const funders = a.funders.map((f) => links.address(f)).join(', ') || '-';
    const max = a.maxEth >= Number.MAX_SAFE_INTEGER ? '∞' : String(a.maxEth);
    parts.push(`funded by ${funders} [${a.minEth}–${max} ETH${a.freshOnly ? ', fresh' : ''}${a.contractMode ? ', via contract' : ''}, ${fmtDuration(a.maxAgeSec)}]`);
  }
  if (t.deployerIn?.length) parts.push(`deployer ∈ {${t.deployerIn.map((d) => links.address(d)).join(', ')}}`);
  if (t.teamWalletsAny?.length) parts.push(`team any of ${t.teamWalletsAny.length} (${t.teamWalletsAny.slice(0, 3).map((d) => links.address(d)).join(', ')}${t.teamWalletsAny.length > 3 ? ', …' : ''})`);
  if (t.nameRegex) parts.push(`name ${code(`/${t.nameRegex}/`)}`);
  if (t.symbolRegex) parts.push(`symbol ${code(`/${t.symbolRegex}/`)}`);
  if (t.launchKind !== 'any') parts.push(`kind ${t.launchKind}`);
  if (t.minDevBuyEth !== undefined || t.maxDevBuyEth !== undefined) parts.push(`dev buy ${t.minDevBuyEth ?? 0}–${t.maxDevBuyEth ?? '∞'} ETH`);
  if (t.require.length) parts.push(`require ${t.require.join('+')}`);
  return parts.join(' · ') || 'trigger: (empty)';
}

export function presetSummary(raw: unknown): string {
  const parsed = PresetSchema.safeParse(raw ?? {});
  if (!parsed.success) return 'preset: (invalid)';
  const p: Preset = parsed.data;
  const parts = [
    `buy ${fmtEth(p.buyEth)}`,
    `tax≤${fmtBps(p.maxTaxBps)}`,
    `TP ${p.takeProfits.map((tp) => `+${tp.pct}%→${tp.sellPct}%`).join(' ') || 'none'}`,
    p.trailing ? `trail +${p.trailing.activatePct}%/-${p.trailing.dropPct}%` : 'trail off',
    `SL -${p.stopLossPct}%`,
  ];
  parts.push(p.timeoutSec != null ? `timeout ${fmtDuration(p.timeoutSec)}` : 'timeout off');
  if (p.exitIfExemptSellsPct != null) parts.push(p.exitIfExemptSellsPct === 0 ? 'exit on first team outflow' : `exit when team sold ≥${p.exitIfExemptSellsPct}%`);
  if (p.maxEntryMcapEth !== undefined) parts.push(`max entry ${p.maxEntryMcapEth} ETH mcap`);
  parts.push(`burst ${p.burst.count}×${p.burst.spacingMs}ms@${p.burst.startMs}ms`);
  if (p.stopAfter !== 1) parts.push(`stop after ${p.stopAfter}`);
  return escapeHtml(parts.join(' · '));
}

export function playStateTag(p: PlayRow): string {
  const review = reviewStatus(p);
  if (p.enabled) return '[ON]';
  if (review === 'pending') return '[REVIEW]';
  if (review === 'rejected') return '[REJECTED]';
  return '[off]';
}

export function playLine(p: PlayRow, links: Links): string {
  const stats = p.stats as Record<string, unknown>;
  const ev = typeof stats.expectancyEth === 'number' ? ` · EV ${fmtEth(stats.expectancyEth, { signed: true })}` : '';
  return [
    `${playStateTag(p)} ${b(`#${p.id} ${p.name || '(unnamed)'}`)}${p.armedCount ? ` · armed ${p.armedCount}` : ''}${ev}`,
    `  ${triggerSummary(p.trigger, links)}`,
    `  ${presetSummary(p.preset)}`,
  ].join('\n');
}

export function playsList(plays: PlayRow[], links: Links): string {
  if (plays.length === 0) return 'No plays yet. Use /play &lt;ca&gt; to discover one or /watch to create a funding-trail watch.';
  const on = plays.filter((p) => p.enabled).length;
  return [`${b(`Plays: ${plays.length}`)} (${on} enabled)`, '', ...plays.map((p) => playLine(p, links))].join('\n');
}

/** Card for a proposed play, sent with the approve/reject keyboard. */
export function playProposalCard(p: PlayRow, links: Links, source?: string | null, summary?: string | null): string {
  const lines = [
    `${b('PLAY PROPOSED')} ${b(`#${p.id} ${p.name || '(unnamed)'}`)}${source ? ` · from ${escapeHtml(source)}` : ''}`,
    triggerSummary(p.trigger, links),
    presetSummary(p.preset),
  ];
  const stats = p.stats as Record<string, unknown>;
  const bt = [
    typeof stats.n === 'number' ? `n=${stats.n}` : null,
    typeof stats.winRate === 'number' ? `win ${fmtPct(stats.winRate * 100).replace('+', '')}` : null,
    typeof stats.expectancyEth === 'number' ? `EV ${fmtEth(stats.expectancyEth, { signed: true })}/snipe` : null,
  ].filter(Boolean);
  if (bt.length) lines.push(`backtest: ${escapeHtml(bt.join(' · '))}`);
  if (summary) lines.push('', escapeHtml(truncate(summary, 1200)));
  lines.push('', 'Approve enables it (the sniper arms it within one NOTIFY). Reject keeps it disabled.');
  return lines.join('\n');
}

export function approvalKeyboard(playId: number): InlineKeyboard {
  return new InlineKeyboard().text('Approve', `play:approve:${playId}`).text('Reject', `play:reject:${playId}`);
}

export function presetView(p: PlayRow): string {
  return [`${b(`Preset of play #${p.id} ${p.name}`)}`, `<pre>${escapeHtml(presetLines(p.preset).join('\n'))}</pre>`].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Armed
// ---------------------------------------------------------------------------------------------

export function armedLine(a: ArmedRow, ctx: FormatCtx): string {
  const value = a.fundedValueWei !== null ? fmtEth(a.fundedValueWei) : '-';
  const left = a.expiresAt ? fmtDuration((a.expiresAt.getTime() - ctx.now.getTime()) / 1000) : '∞';
  const age = a.armedAt ? fmtDuration((ctx.now.getTime() - a.armedAt.getTime()) / 1000) : '?';
  return `${ctx.links.address(a.wallet)} ← ${value} from ${ctx.links.address(a.sourceFunder)} · play #${a.playId}${a.playName ? ` ${escapeHtml(a.playName)}` : ''} · ${age} ago, expires in ${left}`;
}

export function armedList(rows: ArmedRow[], ctx: FormatCtx): string {
  if (rows.length === 0) return 'No armed wallets.';
  return [b(`Armed wallets: ${rows.length}`), ...rows.map((a) => `• ${armedLine(a, ctx)}`)].join('\n');
}

export function armedMessage(a: ArmedRow, ctx: FormatCtx): string {
  return [
    `${b('ARMED')} play #${a.playId}${a.playName ? ` ${b(a.playName)}` : ''}`,
    `wallet ${ctx.links.address(a.wallet)} funded ${a.fundedValueWei !== null ? fmtEth(a.fundedValueWei) : '-'} by ${ctx.links.address(a.sourceFunder)}${a.fundedTx ? ` (${ctx.links.tx(a.fundedTx)})` : ''}`,
    a.expiresAt ? `expires ${fmtTime(a.expiresAt, ctx.tz)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------------------------
// Snipes
// ---------------------------------------------------------------------------------------------

interface BurstItem {
  nonce?: number;
  hash?: string;
  sentAt?: number;
  endpoint?: string;
  status?: string;
  block?: number;
  ts?: number;
}

function burstItems(s: SnipeRow): BurstItem[] {
  return s.burst.filter((x): x is BurstItem => !!x && typeof x === 'object');
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

export function burstSummary(s: SnipeRow): string {
  const items = burstItems(s);
  if (items.length === 0) return 'burst: (none recorded)';
  const nonces = items.map((i) => i.nonce).filter((n): n is number => typeof n === 'number');
  const sent = items.map((i) => i.sentAt).filter((n): n is number => typeof n === 'number');
  const spanMs = sent.length > 1 ? Math.max(...sent) - Math.min(...sent) : 0;
  const count = (key: (i: BurstItem) => string | undefined): string =>
    Object.entries(
      items.reduce<Record<string, number>>((acc, i) => {
        const k = key(i);
        if (k) acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .map(([k, n]) => `${k}×${n}`)
      .join(' ');
  const parts = [`burst ${items.length} tx`];
  if (nonces.length) parts.push(`nonces ${Math.min(...nonces)}–${Math.max(...nonces)}`);
  parts.push(`span ${spanMs} ms`);
  const eps = count((i) => (i.endpoint ? hostOf(i.endpoint) : undefined));
  if (eps) parts.push(`via ${eps}`);
  const st = count((i) => i.status);
  if (st) parts.push(st);
  return escapeHtml(parts.join(' · '));
}

function decisionNote(s: SnipeRow): string | null {
  const d = s.decision;
  const pick = (k: string): string | null => {
    const v = d[k];
    if (typeof v === 'string' && v) return v;
    if (Array.isArray(v) && v.length) return v.map(String).join('+');
    return null;
  };
  // services/sniper records the matched rules as decision.reasons (string[])
  const matched = pick('reasons') ?? pick('matched') ?? pick('matchedBy');
  const reason = pick('reason');
  const parts = [matched ? `matched ${matched}` : null, reason].filter(Boolean);
  return parts.length ? escapeHtml(parts.join(' · ')) : null;
}

function snipeHeader(kind: string, s: SnipeRow): string {
  return `${modeTag(s.mode)} ${b(kind)} #${s.id} · play #${s.playId}${s.playName ? ` ${escapeHtml(s.playName)}` : ''}`;
}

export function snipeSentMessage(s: SnipeRow, ctx: FormatCtx): string {
  const quote = s.quoteInWei !== null ? fmtEth(s.quoteInWei) : typeof s.decision.buyEth === 'number' ? fmtEth(s.decision.buyEth) : '-';
  const note = decisionNote(s);
  return [
    snipeHeader(s.mode === 'paper' ? 'SNIPE PLANNED' : 'SNIPE SENT', s),
    ctx.links.token(s.token, s.tokenName, s.tokenSymbol),
    `buy ${quote} · ${burstSummary(s)}`,
    note ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** launch time: launches.ts, else the sniper's decision.launch.ts (unix seconds) */
function launchTime(s: SnipeRow): Date | null {
  if (s.launchTs) return s.launchTs;
  const launch = s.decision.launch;
  const ts = launch && typeof launch === 'object' ? (launch as Record<string, unknown>).ts : undefined;
  return typeof ts === 'number' && ts > 0 ? new Date(ts * 1000) : null;
}

function entryMcapEth(s: SnipeRow): number | null {
  return mcapEthFromPrice(s.entryPrice);
}

export function snipeFilledMessage(s: SnipeRow, ctx: FormatCtx): string {
  const quoteEth = s.quoteInWei !== null ? weiToEth(s.quoteInWei) : null;
  const taxEth = s.taxPaidWei !== null ? weiToEth(s.taxPaidWei) : null;
  const taxPct = quoteEth && taxEth !== null ? (taxEth / quoteEth) * 100 : null;
  const after = secondsBetween(launchTime(s), s.buyTs);
  const landed = burstItems(s).find((i) => i.status === 'mined' && i.hash);
  return [
    snipeHeader('FILLED', s),
    ctx.links.token(s.token, s.tokenName, s.tokenSymbol),
    `entry mcap ${fmtMcap(entryMcapEth(s), ctx.ethUsd)} · bought ${fmtTokens(s.tokensOut)} for ${fmtEth(s.quoteInWei)}`,
    `tax paid ${fmtEth(s.taxPaidWei)}${taxPct !== null ? ` (${taxPct.toFixed(2)}%)` : ''}${after !== null ? ` · +${after.toFixed(0)} s after launch` : ''}${s.buyBlock !== null ? ` · block ${s.buyBlock}` : ''}`,
    landed?.hash ? `tx ${ctx.links.tx(landed.hash)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function exitReason(s: SnipeRow): string {
  const sells = s.sells.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  const reasons = sells.map((x) => x.reason).filter((r): r is string => typeof r === 'string' && r.length > 0);
  if (reasons.length) return reasons.join(' → ');
  return s.notes ?? 'unknown';
}

export function snipeClosedMessage(s: SnipeRow, ctx: FormatCtx): string {
  const pnl = s.realizedPnlEth;
  const quoteEth = s.quoteInWei !== null ? weiToEth(s.quoteInWei) : null;
  const pct = pnl !== null && quoteEth ? (pnl / quoteEth) * 100 : null;
  const hold = secondsBetween(s.buyTs ?? s.decidedAt, s.closedAt);
  const lastSell = [...s.sells].reverse().find((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as Record<string, unknown>).txHash === 'string');
  return [
    snipeHeader(pnl !== null && pnl >= 0 ? 'CLOSED +' : 'CLOSED -', s),
    ctx.links.token(s.token, s.tokenName, s.tokenSymbol),
    `PnL ${pnl !== null ? fmtEth(pnl, { signed: true }) : '-'}${pnl !== null ? usdSigned(pnl, ctx) : ''} · ${fmtPct(pct)} on ${fmtEth(s.quoteInWei)}`,
    `reason ${escapeHtml(exitReason(s))} · held ${fmtDuration(hold)} · entry mcap ${fmtMcap(entryMcapEth(s), ctx.ethUsd)}`,
    lastSell ? `exit tx ${ctx.links.tx(lastSell.txHash as string)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function snipeAbortedMessage(s: SnipeRow, ctx: FormatCtx): string {
  const reason =
    s.notes ?? (typeof s.decision.abortReason === 'string' ? s.decision.abortReason : null) ?? (typeof s.decision.reason === 'string' ? s.decision.reason : null) ?? 'no reason recorded';
  return [
    snipeHeader(s.status === 'failed' ? 'FAILED' : 'ABORTED', s),
    ctx.links.token(s.token, s.tokenName, s.tokenSymbol),
    `reason: ${escapeHtml(truncate(reason, 300))}`,
    burstItems(s).length ? burstSummary(s) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function positionsMessage(rows: SnipeRow[], ctx: FormatCtx): string {
  if (rows.length === 0) return 'No open positions.';
  const lines = [b(`Open positions: ${rows.length}`)];
  for (const s of rows) {
    const entry = s.entryPrice;
    const last = s.lastPrice ?? null;
    const unreal = entry && last ? (last / entry - 1) * 100 : null;
    const valueEth = last !== null && s.tokensOut !== null ? weiToEth(s.tokensOut) * last : null;
    const held = secondsBetween(s.buyTs ?? s.decidedAt, ctx.now);
    lines.push(
      [
        `${modeTag(s.mode)} #${s.id} ${s.status === 'pending' ? '(pending fill) ' : ''}${ctx.links.token(s.token, s.tokenName, s.tokenSymbol)}`,
        `  in ${fmtEth(s.quoteInWei)} @ ${fmtMcap(entryMcapEth(s), ctx.ethUsd)} · now ${fmtMcap(mcapEthFromPrice(last), ctx.ethUsd)} ${fmtPct(unreal)}${valueEth !== null ? ` · value ${fmtEth(valueEth)}` : ''} · held ${fmtDuration(held)}`,
      ].join('\n'),
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// PnL / status / daily
// ---------------------------------------------------------------------------------------------

function bucketLines(label: string, bk: PnlBucket, ctx: FormatCtx): string[] {
  if (bk.closed === 0 && bk.aborted === 0 && bk.failed === 0) return [`${b(label)}: no trades`];
  const winRate = bk.closed ? (bk.wins / bk.closed) * 100 : null;
  return [
    `${b(label)}: ${fmtEth(bk.pnlEth, { signed: true })}${usdSigned(bk.pnlEth, ctx)} over ${bk.closed} closed (${bk.wins}W/${bk.losses}L${winRate !== null ? `, ${winRate.toFixed(0)}% win` : ''})`,
    `  best ${bk.bestEth !== null ? fmtEth(bk.bestEth, { signed: true }) : '-'} · worst ${bk.worstEth !== null ? fmtEth(bk.worstEth, { signed: true }) : '-'} · tax paid ${fmtEth(bk.taxPaidWei)} · invested ${fmtEth(bk.investedWei)} · aborted ${bk.aborted} · failed ${bk.failed}`,
  ];
}

export function pnlMessage(p: PnlSummary, days: number, ctx: FormatCtx): string {
  const lines = [b(`PnL, last ${days === 1 ? '24 h' : `${days} days`}`) + ` (since ${escapeHtml(fmtTime(p.since, ctx.tz))})`, ...bucketLines('Live', p.live, ctx), ...bucketLines('Paper', p.paper, ctx)];
  if (p.byPlay.length) {
    lines.push('', b('By play'));
    for (const r of p.byPlay.slice(0, 15)) {
      lines.push(`${modeTag(r.mode)} #${r.playId} ${escapeHtml(r.name ?? '')}: ${fmtEth(r.pnlEth, { signed: true })} (${r.closed})`);
    }
  }
  lines.push('', 'Gas is not included (≈0.000004 ETH per 200k-gas tx at 0.02 gwei).');
  return lines.join('\n');
}

export interface ChainHeads {
  node: number | null;
  publicRpc: number | null;
}

export function killLine(k: KillState): string {
  if (!k.on) return 'kill switch: off (trading allowed)';
  return `${b('KILL SWITCH ON')}${k.reason ? `: ${escapeHtml(k.reason)}` : ''}${k.by ? ` (by ${escapeHtml(k.by)}${k.at ? ` at ${escapeHtml(k.at)}` : ''})` : ''}`;
}

export function statusMessage(s: StatusSnapshot, heads: ChainHeads, ctx: FormatCtx): string {
  const lines = [b('Status') + ` · ${escapeHtml(fmtTime(ctx.now, ctx.tz))}`, killLine(s.kill)];
  if (s.feed) {
    const staleMs = s.feed.arrivalMs !== null ? ctx.now.getTime() - s.feed.arrivalMs : null;
    const deliveryMs = s.feed.arrivalMs !== null && s.feed.ts ? s.feed.arrivalMs - s.feed.ts.getTime() : null;
    lines.push(
      `feed: block ${s.feed.block}${staleMs !== null ? `, last frame ${fmtDuration(staleMs / 1000)} ago` : ''}${deliveryMs !== null ? `, delivery ~${Math.max(0, Math.round(deliveryMs))} ms after block ts` : ''}${staleMs !== null && staleMs > 60_000 ? ' ' + b('STALE') : ''}`,
    );
  } else {
    lines.push('feed: no feed_blocks yet (sniper not running?)');
  }
  const nodeParts: string[] = [];
  if (heads.node !== null) nodeParts.push(`node ${heads.node}`);
  if (heads.publicRpc !== null) nodeParts.push(`public ${heads.publicRpc}`);
  if (heads.node !== null && heads.publicRpc !== null) {
    const lag = heads.publicRpc - heads.node;
    nodeParts.push(`lag ${lag} blocks${lag > 50 ? ' ' + b('LAGGING') : ''}`);
  }
  if (s.indexerBlock !== null) {
    const ref = heads.node ?? heads.publicRpc;
    nodeParts.push(`indexer ${s.indexerBlock}${ref !== null ? ` (${ref - s.indexerBlock} behind)` : ''}`);
  }
  lines.push(`chain: ${nodeParts.join(' · ') || 'unknown'}`);
  lines.push(`positions: ${s.openPositions.live} live, ${s.openPositions.paper} paper`);
  lines.push(
    `PnL today (UTC): live ${fmtEth(s.dailyPnl.live, { signed: true })}${usdSigned(s.dailyPnl.live, ctx)} · paper ${fmtEth(s.dailyPnl.paper, { signed: true })}`,
  );
  lines.push(`plays: ${s.enabledPlays} enabled${s.pendingReview ? `, ${s.pendingReview} awaiting review` : ''} · armed wallets: ${s.armed}`);
  if (s.lastError) lines.push(`last error: ${escapeHtml(s.lastError.source)}/${escapeHtml(s.lastError.type)} at ${escapeHtml(fmtTime(s.lastError.ts, ctx.tz))}`);
  lines.push(`ETH/USD: ${s.ethUsd !== null ? fmtUsd(s.ethUsd) : 'not set (settings.eth_usd)'}`);
  return lines.join('\n');
}

export function dailySummaryMessage(p: PnlSummary, s: StatusSnapshot, errors24h: number, ctx: FormatCtx): string {
  return [
    b('Daily summary') + ` · ${escapeHtml(fmtTime(ctx.now, ctx.tz))}`,
    ...bucketLines('Live 24 h', p.live, ctx),
    ...bucketLines('Paper 24 h', p.paper, ctx),
    `open positions: ${s.openPositions.live} live, ${s.openPositions.paper} paper`,
    `plays: ${s.enabledPlays} enabled${s.pendingReview ? `, ${s.pendingReview} awaiting review` : ''} · armed: ${s.armed}`,
    `errors in 24 h: ${errors24h}`,
    killLine(s.kill),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Events / agent results
// ---------------------------------------------------------------------------------------------

function payloadText(payload: unknown): string {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'object') {
    const o = payload as Record<string, unknown>;
    for (const k of ['message', 'error', 'summary', 'reason', 'msg']) {
      if (typeof o[k] === 'string' && o[k]) return o[k] as string;
    }
  }
  try {
    return JSON.stringify(payload, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(payload);
  }
}

export function eventMessage(e: EventRow, ctx: FormatCtx): string {
  const tag = e.level === 'error' ? '[ERROR]' : e.level === 'warn' ? '[WARN]' : '[INFO]';
  const text = payloadText(e.payload);
  return [`${b(tag)} ${escapeHtml(e.source)}/${escapeHtml(e.type)} · ${escapeHtml(fmtTime(e.ts, ctx.tz))}`, text ? `<pre>${escapeHtml(truncate(text, 1500))}</pre>` : ''].filter(Boolean).join('\n');
}

export function agentResultMessage(kind: 'play' | 'scout' | 'backtest', label: string, r: AgentRunSummary, durationSec: number): string {
  const title = kind === 'play' ? 'Play finder' : kind === 'scout' ? 'Scout' : 'Backtest';
  const meta = [r.runId !== null ? `run #${r.runId}` : null, `${fmtDuration(durationSec)}`, r.costUsd !== null ? `cost ${fmtUsd(r.costUsd)}` : null].filter(Boolean).join(' · ');
  const lines = [`${b(`${title} done`)} ${escapeHtml(label)} · ${escapeHtml(meta)}`];
  if (r.error) lines.push(`${b('error')}: ${escapeHtml(truncate(r.error, 500))}`);
  if (r.summary) lines.push('', escapeHtml(truncate(r.summary, 3000)));
  if (r.proposedPlayIds.length) lines.push('', `proposed play(s): ${r.proposedPlayIds.map((i) => `#${i}`).join(', ')} - approval card below`);
  return lines.join('\n');
}

export function killMessage(k: KillState, changedBy?: string): string {
  if (k.on) return `${b('KILL SWITCH ON')}${k.reason ? ` - ${escapeHtml(k.reason)}` : ''}${changedBy ? ` (by ${escapeHtml(changedBy)})` : ''}\nThe sniper must not open new positions; open positions keep their exits.`;
  return `${b('Trading resumed')} - kill switch off${changedBy ? ` (by ${escapeHtml(changedBy)})` : ''}`;
}

export { shortAddr };
