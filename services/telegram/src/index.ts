/** @hood/telegram – public surface (the service itself starts from src/main.ts). */
export { createBot, resolveReportPath, type BotConfig, type BotDeps, type CreatedBot } from './bot.js';
export { adminOnly, parseAdminIds, userLabel } from './auth.js';
export { EnvSchema, loadEnv, notifyChats, type Env } from './env.js';
export * from './format.js';
export { JobRunner, type JobKind, type JobSpec } from './jobs.js';
export * from './messages.js';
export { Messenger, type SendExtra } from './messenger.js';
export { Notifier, NOTIFY_CHANNELS, snipeIdsFromPayload, snipeSteps, type NotifierConfig, type NotifierDeps, type SnipeStep } from './notifier.js';
export * from './parse.js';
export { normalizeAgentResult, normalizeWatchPlay, ServiceUnavailableError, type AgentPort, type AgentRunSummary, type TrackerPort, type WatchPlay, type WatchPlayInput } from './ports.js';
export { applyPresetAssignments, presetLines, presetPaths, schemaAtPath, type PresetChange, type PresetResult } from './preset.js';
export { Registry } from './registry.js';
export * from './store.js';
export { PgStore } from './store-pg.js';
export { loadAgentPort, loadTrackerPort, type ModuleLoader } from './wiring.js';
