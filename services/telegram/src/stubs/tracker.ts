/**
 * ============================================================================
 * STUB - used only when services/tracker's buildWatchPlay cannot be loaded (wiring.ts).
 * ============================================================================
 * Real implementation: services/tracker/src/watch.ts `buildWatchPlay`. This fallback builds the
 * same SPEC §4 play locally (Packet Tracker semantics): arm wallets that receive [minEth, maxEth]
 * from `funder` (fresh wallets only unless `any`), expire after 48 h, preset = given or defaults.
 */
import { PlayTriggerSchema, PresetSchema } from '@hood/core';
import type { TrackerPort, WatchPlay, WatchPlayInput } from '../ports.js';

export function buildWatchPlayLocal(input: WatchPlayInput): WatchPlay {
  const trigger = PlayTriggerSchema.parse({
    armedWallet: {
      funders: [input.funder],
      minEth: input.minEth,
      maxEth: input.maxEth,
      freshOnly: input.fresh,
      maxAgeSec: 48 * 3600,
      contractMode: false,
    },
    launchKind: 'any',
    require: ['armedWallet'],
  });
  return {
    name: input.name ?? `watch ${input.funder.slice(0, 8)} ${input.minEth}-${input.maxEth}`,
    trigger,
    preset: PresetSchema.parse(input.preset ?? {}),
    operatorId: null,
  };
}

export function stubTrackerPort(): TrackerPort {
  return { available: false, buildWatchPlay: async (input) => buildWatchPlayLocal(input) };
}
