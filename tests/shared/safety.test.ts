import { createDefaultSettings, createDefaultState } from "@/shared/defaults";
import {
  canRunNext,
  clampSettings,
  countWithinWindow,
  COOLDOWN_MS,
  DAY_MS,
  HARD_LIMITS,
  HOUR_MS,
  isWithinActiveHours,
  MINUTE_MS,
  nextActiveWindowStart,
  pickIntervalMs,
  pickProfileDwellMs,
  purgeExpiredTimestamps,
} from "@/shared/safety";
import type { Settings, UnfollowQueue } from "@/shared/types";

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    preset: "custom",
    intervalMinSec: 90,
    intervalMaxSec: 150,
    hourlyCap: 5,
    dailyCap: 20,
    sessionCap: 10,
    syncTargetCount: 1_000,
    activeHours: { enabled: false, start: "09:00", end: "23:00" },
    ...overrides,
  };
}

function queue(overrides: Partial<UnfollowQueue> = {}): UnfollowQueue {
  return {
    status: "running",
    items: [],
    cursor: 0,
    nextAt: null,
    sessionStartedAt: null,
    actionTimestamps: [],
    cooldownUntil: null,
    pauseReason: null,
    consecutiveFailures: 0,
    ownerUserId: "self",
    ...overrides,
  };
}

/** Local-time helper so active-hours assertions are timezone independent. */
function localTime(hour: number, minute = 0): number {
  return new Date(2026, 7, 17, hour, minute, 0, 0).getTime();
}

describe("hard safety constants", () => {
  it("exposes the P0 floors and ceilings", () => {
    expect(HARD_LIMITS).toEqual({
      minIntervalSec: 2,
      maxHourlyCap: 12,
      maxDailyCap: 40,
      maxSessionCap: 20,
      minSyncTargetCount: 100,
      maxSyncTargetCount: 5_000,
    });
  });

  it("uses a fixed 60-minute circuit-breaker cooldown", () => {
    expect(COOLDOWN_MS).toBe(60 * 60 * 1000);
  });
});

describe("clampSettings", () => {
  it("clamps custom settings to hard safety limits", () => {
    const result = clampSettings({
      preset: "custom",
      intervalMinSec: 1,
      intervalMaxSec: 20,
      hourlyCap: 99,
      dailyCap: 99,
      sessionCap: 99,
      syncTargetCount: 1_000,
      activeHours: { enabled: false, start: "09:00", end: "23:00" },
    });

    expect(result).toMatchObject({
      intervalMinSec: 2,
      intervalMaxSec: 20,
      hourlyCap: 12,
      dailyCap: 40,
      sessionCap: 20,
    });
  });

  it("forces the exact Safe preset values", () => {
    const result = clampSettings(
      settings({
        preset: "safe",
        intervalMinSec: 5,
        intervalMaxSec: 5,
        hourlyCap: 99,
        dailyCap: 99,
        sessionCap: 99,
      }),
    );

    expect(result).toMatchObject({
      preset: "safe",
      intervalMinSec: 2,
      intervalMaxSec: 10,
      hourlyCap: 5,
      dailyCap: 20,
      sessionCap: 10,
    });
  });

  it("forces the exact Balanced preset values", () => {
    const result = clampSettings(
      settings({
        preset: "balanced",
        intervalMinSec: 1,
        intervalMaxSec: 2,
        hourlyCap: 99,
        dailyCap: 99,
        sessionCap: 99,
      }),
    );

    expect(result).toMatchObject({
      preset: "balanced",
      intervalMinSec: 2,
      intervalMaxSec: 10,
      hourlyCap: 8,
      dailyCap: 30,
      sessionCap: 15,
    });
  });

  it("keeps compliant custom values untouched", () => {
    const result = clampSettings(
      settings({
        preset: "custom",
        intervalMinSec: 120,
        intervalMaxSec: 240,
        hourlyCap: 4,
        dailyCap: 15,
        sessionCap: 8,
      }),
    );

    expect(result).toMatchObject({
      preset: "custom",
      intervalMinSec: 120,
      intervalMaxSec: 240,
      hourlyCap: 4,
      dailyCap: 15,
      sessionCap: 8,
    });
  });

  it("never lets the maximum interval fall below the minimum interval", () => {
    const result = clampSettings(settings({ intervalMinSec: 200, intervalMaxSec: 100 }));

    expect(result.intervalMinSec).toBe(200);
    expect(result.intervalMaxSec).toBe(200);
  });

  it("repairs corrupted numeric values with conservative fallbacks", () => {
    const result = clampSettings(
      settings({
        intervalMinSec: Number.NaN,
        intervalMaxSec: -10,
        hourlyCap: 0,
        dailyCap: Number.NaN,
        sessionCap: -3,
      }),
    );

    expect(result).toMatchObject({
      intervalMinSec: 2,
      intervalMaxSec: 2,
      hourlyCap: 1,
      dailyCap: 1,
      sessionCap: 1,
    });
  });

  it("falls back to the Safe preset when the stored preset is unknown", () => {
    const result = clampSettings(settings({ preset: "aggressive" as Settings["preset"] }));

    expect(result.preset).toBe("safe");
    expect(result.intervalMinSec).toBe(2);
  });

  it("preserves valid active hours and repairs invalid ones", () => {
    const kept = clampSettings(
      settings({ activeHours: { enabled: true, start: "08:30", end: "22:15" } }),
    );
    expect(kept.activeHours).toEqual({ enabled: true, start: "08:30", end: "22:15" });

    const repaired = clampSettings(
      settings({ activeHours: { enabled: false, start: "25:99", end: "" } }),
    );
    expect(repaired.activeHours).toEqual({ enabled: false, start: "09:00", end: "23:00" });
  });

  it("restores the protective default window when active hours are missing", () => {
    const missing = clampSettings(
      settings({ activeHours: undefined as unknown as Settings["activeHours"] }),
    );

    expect(missing.activeHours).toEqual({ enabled: false, start: "09:00", end: "23:00" });
  });

  it("defaults the sync target to 1000", () => {
    expect(createDefaultSettings().syncTargetCount).toBe(1_000);
  });

  it.each([
    [1, 100],
    [100, 100],
    [1_234.9, 1_234],
    [5_000, 5_000],
    [99_999, 5_000],
    [Number.NaN, 1_000],
  ])("clamps sync target %s to %s", (value, expected) => {
    expect(clampSettings(settings({ syncTargetCount: value })).syncTargetCount).toBe(expected);
  });

  it("keeps the sync target independent of safety presets", () => {
    expect(
      clampSettings(settings({ preset: "safe", syncTargetCount: 2_000 })).syncTargetCount,
    ).toBe(2_000);
    expect(
      clampSettings(settings({ preset: "balanced", syncTargetCount: 3_000 })).syncTargetCount,
    ).toBe(3_000);
  });

  it("restores the protective default window when active hours are structurally invalid", () => {
    const notAnObject = clampSettings(
      settings({ activeHours: "09:00-23:00" as unknown as Settings["activeHours"] }),
    );
    expect(notAnObject.activeHours).toEqual({ enabled: false, start: "09:00", end: "23:00" });

    const empty = clampSettings(settings({ activeHours: {} as Settings["activeHours"] }));
    expect(empty.activeHours).toEqual({ enabled: false, start: "09:00", end: "23:00" });

    const missingFlag = clampSettings(
      settings({
        activeHours: { start: "10:00", end: "20:00" } as unknown as Settings["activeHours"],
      }),
    );
    expect(missingFlag.activeHours).toEqual({ enabled: false, start: "10:00", end: "20:00" });
  });
});

describe("isWithinActiveHours", () => {
  it("allows every hour when the window is disabled", () => {
    const window = { enabled: false, start: "09:00", end: "23:00" };

    expect(isWithinActiveHours(window, localTime(3))).toBe(true);
  });

  it("respects a same-day window", () => {
    const window = { enabled: true, start: "09:00", end: "23:00" };

    expect(isWithinActiveHours(window, localTime(9))).toBe(true);
    expect(isWithinActiveHours(window, localTime(22, 59))).toBe(true);
    expect(isWithinActiveHours(window, localTime(23))).toBe(false);
    expect(isWithinActiveHours(window, localTime(8, 59))).toBe(false);
  });

  it("respects a window that wraps past midnight", () => {
    const window = { enabled: true, start: "22:00", end: "06:00" };

    expect(isWithinActiveHours(window, localTime(23))).toBe(true);
    expect(isWithinActiveHours(window, localTime(1))).toBe(true);
    expect(isWithinActiveHours(window, localTime(12))).toBe(false);
  });
});

describe("nextActiveWindowStart", () => {
  const window = { enabled: true, start: "09:00", end: "23:00" };

  it("returns today's start when the window has not opened yet", () => {
    expect(nextActiveWindowStart(window, localTime(2))).toBe(localTime(9));
  });

  it("returns the next calendar day once the evening end has passed", () => {
    const nextMorning = new Date(2026, 7, 18, 9, 0, 0, 0).getTime();

    expect(nextActiveWindowStart(window, localTime(23, 30))).toBe(nextMorning);
    expect(nextActiveWindowStart(window, localTime(9))).toBe(nextMorning);
  });
});

describe("timestamp windows", () => {
  it("counts only timestamps inside the window", () => {
    const now = 10 * HOUR_MS;
    const timestamps = [now - 30 * 60 * 1000, now - 2 * HOUR_MS, now - 2 * DAY_MS];

    expect(countWithinWindow(timestamps, now, HOUR_MS)).toBe(1);
    expect(countWithinWindow(timestamps, now, DAY_MS)).toBe(2);
  });

  it("purges timestamps older than the retention window", () => {
    const now = 3 * DAY_MS;
    const recent = now - HOUR_MS;
    const stale = now - 25 * HOUR_MS;

    expect(purgeExpiredTimestamps([stale, recent], now, DAY_MS)).toEqual([recent]);
  });
});

describe("pickIntervalMs", () => {
  it("samples uniformly inside the configured band", () => {
    const safe = clampSettings(settings({ preset: "safe" }));

    expect(pickIntervalMs(safe, () => 0)).toBe(2_000);
    expect(pickIntervalMs(safe, () => 1)).toBe(10_000);
    expect(pickIntervalMs(safe, () => 0.5)).toBe(6_000);
  });

  it("never returns a delay below the hard interval floor", () => {
    const unsafe = settings({ intervalMinSec: 1, intervalMaxSec: 2 });

    expect(pickIntervalMs(unsafe, () => 0)).toBe(2_000);
  });
});

describe("pickProfileDwellMs", () => {
  it("samples uniformly inside the profile dwell band", () => {
    expect(pickProfileDwellMs(() => 0)).toBe(2_000);
    expect(pickProfileDwellMs(() => 1)).toBe(10_000);
    expect(pickProfileDwellMs(() => 0.5)).toBe(6_000);
  });
});

describe("default persisted state", () => {
  it("starts on the Safe preset with the default active-hours window", () => {
    const state = createDefaultState();

    expect(state.settings).toEqual({
      preset: "safe",
      intervalMinSec: 2,
      intervalMaxSec: 10,
      hourlyCap: 5,
      dailyCap: 20,
      sessionCap: 10,
      syncTargetCount: 1_000,
      activeHours: { enabled: false, start: "09:00", end: "23:00" },
    });
    expect(state.unfollowQueue.status).toBe("idle");
    expect(state.unfollowQueue.actionTimestamps).toEqual([]);
    expect(state.following).toEqual({});
    expect(state.whitelist).toEqual([]);
    expect(state.auditLog).toEqual([]);
  });

  it("already satisfies the safety clamp", () => {
    expect(clampSettings(createDefaultSettings())).toEqual(createDefaultSettings());
  });

  it("returns independent copies that cannot corrupt the shared defaults", () => {
    const first = createDefaultState();
    first.settings.activeHours.enabled = true;
    first.unfollowQueue.actionTimestamps.push(1);

    const second = createDefaultState();

    expect(second.settings.activeHours.enabled).toBe(false);
    expect(second.unfollowQueue.actionTimestamps).toEqual([]);
  });
});

describe("canRunNext", () => {
  const now = localTime(12);

  it("allows the next unfollow when the queue is running and within quota", () => {
    const decision = canRunNext(queue({ nextAt: now - 1_000 }), now, settings());

    expect(decision).toEqual({ allowed: true, reason: null, retryAt: null });
  });

  it("blocks while the circuit breaker cooldown is active", () => {
    const cooldownUntil = now + COOLDOWN_MS;

    const decision = canRunNext(queue({ status: "cooldown", cooldownUntil }), now, settings());

    expect(decision).toEqual({ allowed: false, reason: "cooldown", retryAt: cooldownUntil });
  });

  it("blocks when the queue is not running", () => {
    const decision = canRunNext(queue({ status: "paused" }), now, settings());

    expect(decision).toMatchObject({ allowed: false, reason: "queue-not-running" });
  });

  it("blocks outside active hours and reports the next window start", () => {
    const decision = canRunNext(
      queue(),
      localTime(2),
      settings({ activeHours: { enabled: true, start: "09:00", end: "23:00" } }),
    );

    expect(decision).toMatchObject({ allowed: false, reason: "outside-active-hours" });
    expect(decision.retryAt).toBe(localTime(9));
  });

  it("blocks at the session cap", () => {
    const sessionStartedAt = now - 30 * 60 * 1000;
    const actionTimestamps = [now - 20 * 60 * 1000, now - 10 * 60 * 1000];

    const decision = canRunNext(
      queue({ sessionStartedAt, actionTimestamps }),
      now,
      settings({ sessionCap: 2, hourlyCap: 12, dailyCap: 40 }),
    );

    expect(decision).toMatchObject({ allowed: false, reason: "session-cap", retryAt: null });
  });

  it("blocks at the hourly cap and reports when the oldest action expires", () => {
    const oldest = now - 50 * 60 * 1000;
    const actionTimestamps = [oldest, now - 20 * 60 * 1000];

    const decision = canRunNext(
      queue({ sessionStartedAt: now, actionTimestamps }),
      now,
      settings({ hourlyCap: 2, dailyCap: 40, sessionCap: 20 }),
    );

    expect(decision).toEqual({
      allowed: false,
      reason: "hourly-cap",
      retryAt: oldest + HOUR_MS,
    });
  });

  it("blocks at the daily cap and reports when the oldest action expires", () => {
    const oldest = now - 20 * HOUR_MS;
    const actionTimestamps = [oldest, now - 5 * HOUR_MS];

    const decision = canRunNext(
      queue({ sessionStartedAt: now, actionTimestamps }),
      now,
      settings({ hourlyCap: 12, dailyCap: 2, sessionCap: 20 }),
    );

    expect(decision).toEqual({
      allowed: false,
      reason: "daily-cap",
      retryAt: oldest + DAY_MS,
    });
  });

  it("waits for the persisted nextAt schedule", () => {
    const nextAt = now + 90_000;

    const decision = canRunNext(queue({ nextAt }), now, settings());

    expect(decision).toEqual({ allowed: false, reason: "waiting-interval", retryAt: nextAt });
  });

  it("blocks after the evening window closed and points at the next morning", () => {
    const decision = canRunNext(
      queue(),
      localTime(23, 30),
      settings({ activeHours: { enabled: true, start: "09:00", end: "23:00" } }),
    );

    expect(decision).toMatchObject({ allowed: false, reason: "outside-active-hours" });
    expect(decision.retryAt).toBe(new Date(2026, 7, 18, 9, 0, 0, 0).getTime());
  });

  it("enforces the hourly hard ceiling even when the caller passes unclamped settings", () => {
    const actionTimestamps = Array.from(
      { length: HARD_LIMITS.maxHourlyCap },
      (_, index) => now - (index + 1) * MINUTE_MS,
    );

    const decision = canRunNext(
      queue({ sessionStartedAt: now, actionTimestamps }),
      now,
      settings({ hourlyCap: 99, dailyCap: 99, sessionCap: 99 }),
    );

    expect(decision).toMatchObject({ allowed: false, reason: "hourly-cap" });
  });

  it("enforces the daily hard ceiling even when the caller passes unclamped settings", () => {
    const actionTimestamps = Array.from(
      { length: HARD_LIMITS.maxDailyCap },
      (_, index) => now - (index + 1) * 30 * MINUTE_MS,
    );

    const decision = canRunNext(
      queue({ sessionStartedAt: now, actionTimestamps }),
      now,
      settings({ hourlyCap: 99, dailyCap: 99, sessionCap: 99 }),
    );

    expect(decision).toMatchObject({ allowed: false, reason: "daily-cap" });
  });

  it("enforces the session hard ceiling even when the caller passes unclamped settings", () => {
    const sessionStartedAt = now - 10 * MINUTE_MS;
    const actionTimestamps = Array.from(
      { length: HARD_LIMITS.maxSessionCap },
      (_, index) => sessionStartedAt + index,
    );

    const decision = canRunNext(
      queue({ sessionStartedAt, actionTimestamps }),
      now,
      settings({ hourlyCap: 99, dailyCap: 99, sessionCap: 99 }),
    );

    expect(decision).toMatchObject({ allowed: false, reason: "session-cap" });
  });

  it("treats broken active hours as an open window", () => {
    const decision = canRunNext(
      queue(),
      localTime(3),
      settings({ activeHours: undefined as unknown as Settings["activeHours"] }),
    );

    expect(decision.allowed).toBe(true);
  });

  it("applies Safe caps when no settings are supplied", () => {
    const actionTimestamps = Array.from({ length: 5 }, (_, index) => now - (index + 1) * 60_000);

    const decision = canRunNext(queue({ sessionStartedAt: now, actionTimestamps }), now);

    expect(decision).toMatchObject({ allowed: false, reason: "hourly-cap" });
  });
});
