import { cleanupCandidateCount, describeQueueProgress, formatWaitDuration } from "@/sidepanel/lib/metrics";
import { createDefaultSettings, createDefaultState, DEFAULT_SCAN_STRATEGIES } from "@/shared/defaults";
import type { FollowingUser } from "@/shared/types";

function user(
  userId: string,
  handle: string,
  followedBy: FollowingUser["followedBy"],
  overrides: Partial<FollowingUser> = {},
): FollowingUser {
  return {
    userId,
    handle,
    name: handle,
    avatarUrl: null,
    followedBy,
    isBlueVerified: null,
    protected: null,
    statusesCount: null,
    friendsCount: null,
    followersCount: null,
    syncedAt: 1,
    ...overrides,
  };
}

describe("cleanupCandidateCount", () => {
  it("counts cleanup candidates using scan strategies", () => {
    const state = {
      ...createDefaultState(),
      following: {
        "1": user("1", "mutual-non-blue", true, { isBlueVerified: false }),
        "2": user("2", "mutual-blue", true, { isBlueVerified: true }),
      },
      settings: {
        ...createDefaultSettings(),
        scanStrategies: { ...DEFAULT_SCAN_STRATEGIES, notFollowingBack: false, nonBlueVerified: true },
      },
    };
    expect(cleanupCandidateCount(state)).toBe(1);
  });
});

describe("formatWaitDuration", () => {
  it("uses seconds below one minute and minutes above it", () => {
    expect(formatWaitDuration(0)).toBe("即将执行");
    expect(formatWaitDuration(8)).toBe("8 秒");
    expect(formatWaitDuration(2_928)).toBe("约 49 分钟");
    expect(formatWaitDuration(3_459)).toBe("约 58 分钟");
  });
});

describe("describeQueueProgress", () => {
  it("explains an hourly-cap hold instead of a raw second countdown", () => {
    const copy = describeQueueProgress({
      inFlight: false,
      reason: "hourly-cap",
      countdownSec: 2_928,
      remaining: 35,
      hourCount: 5,
      hourlyCap: 5,
      sessionCount: 0,
      sessionCap: 10,
    });

    expect(copy.title).toBe("等待每小时上限");
    expect(copy.wait).toContain("已达每小时上限（5/5）");
    expect(copy.wait).toContain("约 49 分钟后自动继续");
    expect(copy.wait).toContain("设置");
    expect(copy.stats).toBe("剩余 35 个 · 本小时 5/5 · 本次会话 0/10");
    expect(copy.hint).toContain("设置");
  });

  it("keeps a short next-item wait in seconds", () => {
    const copy = describeQueueProgress({
      inFlight: false,
      reason: "waiting-interval",
      countdownSec: 8,
      remaining: 12,
      hourCount: 2,
      hourlyCap: 5,
      sessionCount: 2,
      sessionCap: 10,
    });

    expect(copy.title).toBe("取关进行中");
    expect(copy.wait).toBe("下一项 8 秒后执行");
    expect(copy.stats).toBe("剩余 12 个 · 本小时 2/5 · 本次会话 2/10");
  });
});
