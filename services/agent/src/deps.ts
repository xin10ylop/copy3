/**
 * Single switch point for workspace dependencies.
 *
 * packages/core and packages/db are built concurrently by other tasks; until their
 * exports exist the agent uses the SPEC-named stubs under ./stubs/. To switch, change
 * the two `from` clauses below to '@hood/core' / '@hood/db' (adjusting names if the
 * real modules differ) and delete src/stubs/.
 */
export {
  TOKEN_SUPPLY,
  PresetSchema,
  PlayTriggerSchema,
  TakeProfitSchema,
  quoteBuy,
  quoteSell,
  snipeTaxBps,
  priceFromReserves,
  mcapFromReserves,
  type CurveReserves,
  type Preset,
  type PlayTrigger,
  type TakeProfit,
} from './stubs/core.js';
export { createDb } from './stubs/db.js';
