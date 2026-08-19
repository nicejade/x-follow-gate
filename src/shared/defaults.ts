/**
 * Initial persisted state.
 *
 * Factories return fresh objects so callers can never mutate shared defaults
 * that are also used as fallbacks elsewhere.
 */

import { SAFE_SETTINGS } from "./safety";
import type { ExtensionState, ScanStrategies, Settings, SyncMeta, UnfollowQueue } from "./types";

/** Bumped whenever persisted state needs a migration. */
export const STATE_VERSION = 3;

/** Storage key holding the whole extension state tree. */
export const STATE_STORAGE_KEY = "extensionState";

export const DEFAULT_SCAN_STRATEGIES: ScanStrategies = {
  notFollowingBack: true,
  nonBlueVerified: false,
  protected: false,
  lowTweetCount: false,
  followRatio: false,
};

export function createDefaultSettings(): Settings {
  return {
    ...SAFE_SETTINGS,
    activeHours: { ...SAFE_SETTINGS.activeHours },
    scanStrategies: { ...DEFAULT_SCAN_STRATEGIES },
  };
}

export function createDefaultSyncMeta(): SyncMeta {
  return {
    status: "idle",
    startedAt: null,
    updatedAt: null,
    stepCount: 0,
    discoveredCount: 0,
    noGrowthSteps: 0,
    likelyComplete: false,
    pauseReason: null,
  };
}

export function createDefaultQueue(): UnfollowQueue {
  return {
    status: "idle",
    items: [],
    cursor: 0,
    nextAt: null,
    sessionStartedAt: null,
    actionTimestamps: [],
    cooldownUntil: null,
    pauseReason: null,
    consecutiveFailures: 0,
    ownerUserId: null,
  };
}

export function createDefaultState(): ExtensionState {
  return {
    version: STATE_VERSION,
    session: { account: null, checkedAt: null },
    following: {},
    syncMeta: createDefaultSyncMeta(),
    whitelist: [],
    candidates: [],
    unfollowQueue: createDefaultQueue(),
    settings: createDefaultSettings(),
    auditLog: [],
  };
}
