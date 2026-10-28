/** Public surface of @hood/tracker (used by telegram / agent). */
export { buildWatchPlay, parseWatchCommand, type WatchSpec, type WatchCommand } from './watch.js';
export {
  matchTransfer,
  funderMatch,
  inRange,
  isFresh,
  armedKey,
  type TransferEvent,
  type WatchPlay,
  type ArmDecision,
  type MatchResult,
  type MatchFacts,
  type RecipientFacts,
  type ContractOrigin,
  type RejectReason,
} from './match.js';
export { Tracker, DEFAULT_TRACKER_CONFIG, type TrackerConfig, type TrackerStats } from './tracker.js';
export { PgTrackerStore, ARMED_CHANNEL, TRACKER_CHECKPOINT_KEY, type TrackerStore, type CandidateChange } from './store.js';
