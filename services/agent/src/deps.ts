/**
 * Single import point for workspace dependencies (packages/core, packages/db), so a
 * rename there touches one file here.
 */
export {
  PresetSchema,
  PlayTriggerSchema,
  launchSecondIsMatcher,
  quoteBuy,
  quoteSell,
  snipeTaxBps,
  snipeTaxWeiFor,
  type Reserves as CurveReserves,
  type Preset,
  type PlayTrigger,
  type TakeProfit,
} from '@hood/core';
export { createDb, fromPglite, applyMigrations, DEFAULT_AUTO_APPROVE, type AutoApprovePolicy, type Sql as HoodSql } from '@hood/db';

/** Launch supply in whole tokens (core: LAUNCH_SUPPLY_WHOLE) for mcap = price * supply. */
export const TOKEN_SUPPLY = 1_000_000_000;
