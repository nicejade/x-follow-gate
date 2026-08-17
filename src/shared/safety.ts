/**
 * Safety presets, hard limits, and quota decisions.
 *
 * These values are the last line of defence against X anti-automation
 * enforcement: the UI may only tighten them, never loosen them.
 */

import type {
  ActiveHours,
  QuotaBlockReason,
  QuotaDecision,
  SafetyPreset,
  Settings,
  UnfollowQueue,
} from "./types";

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Fixed P0 circuit-breaker cooldown after 401/403/429 or three failures. */
export const COOLDOWN_MS = 60 * MINUTE_MS;

/** Absolute limits; custom settings can never cross them. */
export const HARD_LIMITS = {
  minIntervalSec: 60,
  maxHourlyCap: 12,
  maxDailyCap: 40,
  maxSessionCap: 20,
  minSyncTargetCount: 100,
  maxSyncTargetCount: 5_000,
} as const;

export const DEFAULT_SYNC_TARGET_COUNT = 1_000;

export const PRESET_LIMITS = {
  safe: {
    intervalMinSec: 90,
    intervalMaxSec: 150,
    hourlyCap: 5,
    dailyCap: 20,
    sessionCap: 10,
  },
  balanced: {
    intervalMinSec: 75,
    intervalMaxSec: 120,
    hourlyCap: 8,
    dailyCap: 30,
    sessionCap: 15,
  },
} as const;

export const DEFAULT_ACTIVE_HOURS: ActiveHours = {
  enabled: true,
  start: "09:00",
  end: "23:00",
};

/** Product default; also the fallback quota profile for `canRunNext`. */
export const SAFE_SETTINGS: Settings = {
  preset: "safe",
  ...PRESET_LIMITS.safe,
  syncTargetCount: DEFAULT_SYNC_TARGET_COUNT,
  activeHours: { ...DEFAULT_ACTIVE_HOURS },
};

const PRESETS: readonly SafetyPreset[] = ["safe", "balanced", "custom"];

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toInt(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, toInt(value, min)));
}

function normalizePreset(preset: SafetyPreset): SafetyPreset {
  return PRESETS.includes(preset) ? preset : "safe";
}

/** Returns minutes since local midnight, or `null` when the input is invalid. */
function parseTimeOfDay(value: string): number | null {
  const match = TIME_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Repairs a stored window. A missing or unreadable record falls back to the
 * protective default instead of an open 24/7 window; an explicit boolean
 * `enabled` is user intent and is always preserved.
 */
function normalizeActiveHours(activeHours: ActiveHours | undefined): ActiveHours {
  if (typeof activeHours !== "object" || activeHours === null) {
    return { ...DEFAULT_ACTIVE_HOURS };
  }

  const enabled =
    typeof activeHours.enabled === "boolean" ? activeHours.enabled : DEFAULT_ACTIVE_HOURS.enabled;
  const { start, end } = activeHours;
  const isValid =
    typeof start === "string" &&
    typeof end === "string" &&
    parseTimeOfDay(start) !== null &&
    parseTimeOfDay(end) !== null;

  if (!isValid) {
    return { ...DEFAULT_ACTIVE_HOURS, enabled };
  }

  return { enabled, start, end };
}

/**
 * Applies presets and hard limits. Safe and Balanced always return their exact
 * documented values; only Custom keeps user numbers, clamped to the floors.
 */
export function clampSettings(settings: Settings): Settings {
  const preset = normalizePreset(settings.preset);
  const activeHours = normalizeActiveHours(settings.activeHours);
  const syncTargetCount = Number.isFinite(settings.syncTargetCount)
    ? clampInt(
        settings.syncTargetCount,
        HARD_LIMITS.minSyncTargetCount,
        HARD_LIMITS.maxSyncTargetCount,
      )
    : DEFAULT_SYNC_TARGET_COUNT;

  if (preset !== "custom") {
    return { preset, ...PRESET_LIMITS[preset], syncTargetCount, activeHours };
  }

  const intervalMinSec = Math.max(
    HARD_LIMITS.minIntervalSec,
    toInt(settings.intervalMinSec, HARD_LIMITS.minIntervalSec),
  );
  const intervalMaxSec = Math.max(intervalMinSec, toInt(settings.intervalMaxSec, intervalMinSec));

  return {
    preset,
    intervalMinSec,
    intervalMaxSec,
    // A cap of zero would silently freeze the queue, so one action stays allowed.
    hourlyCap: clampInt(settings.hourlyCap, 1, HARD_LIMITS.maxHourlyCap),
    dailyCap: clampInt(settings.dailyCap, 1, HARD_LIMITS.maxDailyCap),
    sessionCap: clampInt(settings.sessionCap, 1, HARD_LIMITS.maxSessionCap),
    syncTargetCount,
    activeHours,
  };
}

export function countWithinWindow(timestamps: number[], now: number, windowMs: number): number {
  const threshold = now - windowMs;
  return timestamps.filter((timestamp) => timestamp > threshold).length;
}

export function purgeExpiredTimestamps(
  timestamps: number[],
  now: number,
  windowMs: number = DAY_MS,
): number[] {
  const threshold = now - windowMs;
  return timestamps.filter((timestamp) => timestamp > threshold);
}

export function isWithinActiveHours(activeHours: ActiveHours, now: number): boolean {
  const window = normalizeActiveHours(activeHours);
  if (!window.enabled) {
    return true;
  }

  const start = parseTimeOfDay(window.start);
  const end = parseTimeOfDay(window.end);
  // A zero-width window would lock the queue out forever, so it stays open.
  if (start === null || end === null || start === end) {
    return true;
  }

  const current = minutesOfDay(now);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

/** Local timestamp of the next moment the active-hours window opens. */
export function nextActiveWindowStart(activeHours: ActiveHours, now: number): number | null {
  const start = parseTimeOfDay(normalizeActiveHours(activeHours).start);
  if (start === null) {
    return null;
  }

  const date = new Date(now);
  const candidate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    Math.floor(start / 60),
    start % 60,
    0,
    0,
  );

  if (candidate.getTime() <= now) {
    candidate.setDate(candidate.getDate() + 1);
  }

  return candidate.getTime();
}

/** Uniform delay inside the configured band, never below the hard floor. */
export function pickIntervalMs(settings: Settings, random: () => number = Math.random): number {
  const min = Math.max(HARD_LIMITS.minIntervalSec, toInt(settings.intervalMinSec, 0));
  const max = Math.max(min, toInt(settings.intervalMaxSec, min));
  const sample = Math.min(1, Math.max(0, random()));

  return Math.round((min + (max - min) * sample) * 1000);
}

/**
 * Decides whether the queue may perform an unfollow right now.
 *
 * The supplied settings are re-clamped here, so a caller that skips
 * `clampSettings` can never authorize more than the P0 hard limits.
 *
 * Checks run from hardest to softest block so the surfaced reason is the one
 * the user has to act on. Item availability is owned by the queue state
 * machine; this function only enforces safety windows, quotas, and schedule.
 */
export function canRunNext(
  queue: UnfollowQueue,
  now: number,
  settings: Settings = SAFE_SETTINGS,
): QuotaDecision {
  const limits = clampSettings(settings);

  if (queue.cooldownUntil !== null && queue.cooldownUntil > now) {
    return blocked("cooldown", queue.cooldownUntil);
  }

  if (queue.status !== "running") {
    return blocked("queue-not-running", null);
  }

  if (!isWithinActiveHours(limits.activeHours, now)) {
    return blocked("outside-active-hours", nextActiveWindowStart(limits.activeHours, now));
  }

  const sessionStartedAt = queue.sessionStartedAt ?? 0;
  const sessionCount = queue.actionTimestamps.filter(
    (timestamp) => timestamp >= sessionStartedAt,
  ).length;
  if (sessionCount >= limits.sessionCap) {
    // Only an explicit user restart may open a new session.
    return blocked("session-cap", null);
  }

  const hourly = quotaRetryAt(queue.actionTimestamps, now, HOUR_MS, limits.hourlyCap);
  if (hourly !== null) {
    return blocked("hourly-cap", hourly);
  }

  const daily = quotaRetryAt(queue.actionTimestamps, now, DAY_MS, limits.dailyCap);
  if (daily !== null) {
    return blocked("daily-cap", daily);
  }

  if (queue.nextAt !== null && now < queue.nextAt) {
    return blocked("waiting-interval", queue.nextAt);
  }

  return { allowed: true, reason: null, retryAt: null };
}

function blocked(reason: QuotaBlockReason, retryAt: number | null): QuotaDecision {
  return { allowed: false, reason, retryAt };
}

function minutesOfDay(now: number): number {
  const date = new Date(now);
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Returns the moment the window frees a slot, or `null` when the cap is not
 * reached yet.
 */
function quotaRetryAt(
  timestamps: number[],
  now: number,
  windowMs: number,
  cap: number,
): number | null {
  const threshold = now - windowMs;
  const inWindow = timestamps.filter((timestamp) => timestamp > threshold).sort((a, b) => a - b);
  if (inWindow.length < cap) {
    return null;
  }

  // Dropping the oldest action out of the window frees exactly one slot.
  const oldest = inWindow[inWindow.length - cap];
  return oldest === undefined ? now + windowMs : oldest + windowMs;
}
