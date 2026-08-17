import { createScrollController, SCROLL_LIMITS } from "@/content/scroll-controller";
import type { ScrollEnvironment } from "@/content/scroll-controller";
import type { ScrollStatus } from "@/shared/types";

const START_TIME = 1_700_000_000_000;
const VIEWPORT = 1_000;

/** Random draws that select a deterministic branch, read as intent in tests. */
const FORWARD = 0.9;
const REVERSE = 0;

/**
 * Deterministic `ScrollEnvironment`.
 *
 * The clock only moves when a scheduled callback runs, so every timing
 * assertion is exact. `schedule` throws when a timer is already pending, which
 * is how the tests enforce "one freshly randomized next step" instead of a
 * periodic fixed timer.
 */
function createFakeEnvironment() {
  let time = START_TIME;
  let visible = true;
  let discovered = 0;
  let viewportHeight = VIEWPORT;
  let nextTimerId = 1;
  let pending: { id: number; callback: () => void; delayMs: number } | null = null;
  const randoms: number[] = [];
  const scrolls: number[] = [];
  const cancelled: number[] = [];
  const delays: number[] = [];

  const env: ScrollEnvironment = {
    now: () => time,
    random: () => randoms.shift() ?? 0.5,
    isVisible: () => visible,
    viewportHeight: () => viewportHeight,
    measureDiscovered: () => discovered,
    scrollBy: (deltaY) => {
      scrolls.push(deltaY);
    },
    schedule: (callback, delayMs) => {
      if (pending !== null) {
        throw new Error("a second timer was scheduled while one was still pending");
      }

      const id = nextTimerId;
      nextTimerId += 1;
      pending = { id, callback, delayMs };
      delays.push(delayMs);

      return id;
    },
    cancel: (timerId) => {
      cancelled.push(timerId);
      if (pending?.id === timerId) {
        pending = null;
      }
    },
  };

  return {
    env,
    scrolls,
    delays,
    cancelled,
    get pending() {
      return pending;
    },
    lastDelay(): number {
      return delays[delays.length - 1] ?? -1;
    },
    setVisible(next: boolean): void {
      visible = next;
    },
    setViewportHeight(next: number): void {
      viewportHeight = next;
    },
    discover(count: number): void {
      discovered += count;
    },
    queueRandoms(...values: number[]): void {
      randoms.push(...values);
    },
    /** Runs the pending callback after advancing the clock by its own delay. */
    tick(): void {
      const current = pending;
      if (current === null) {
        throw new Error("no pending timer to run");
      }

      pending = null;
      time += current.delayMs;
      current.callback();
    },
    /** Moves the clock without firing the timer, as real waiting would. */
    advance(ms: number): void {
      time += ms;
    },
  };
}

type Fake = ReturnType<typeof createFakeEnvironment>;

/** Queues the three draws one step consumes: direction, distance, next delay. */
function queueStep(fake: Fake, kind: number, distance = 0.5, delay = 0.5) {
  fake.queueRandoms(kind, distance, delay);
}

/** Runs steps until the round leaves `running`, with a hard bound on iterations. */
function runUntilRoundEnds(
  fake: Fake,
  controller: { getStatus(): ScrollStatus },
  step: () => void,
  maxTicks = 400,
): void {
  for (let index = 0; index < maxTicks; index += 1) {
    if (controller.getStatus().status !== "running") {
      return;
    }

    step();
    fake.tick();
  }

  throw new Error("the round never ended");
}

describe("createScrollController", () => {
  it("waits a human pause before the first step instead of scrolling immediately", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });

    controller.start();

    expect(fake.scrolls).toEqual([]);
    expect(fake.pending).not.toBeNull();
    expect(fake.lastDelay()).toBeGreaterThanOrEqual(SCROLL_LIMITS.minPauseMs);
    expect(fake.lastDelay()).toBeLessThanOrEqual(SCROLL_LIMITS.maxPauseMs);
    expect(controller.getStatus()).toMatchObject({ status: "running", stepCount: 0 });
  });

  it("scrolls 40%-80% of the viewport on every forward step", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start();

    for (const distance of [0, 0.25, 0.5, 0.75, 1]) {
      queueStep(fake, FORWARD, distance);
      fake.discover(3);
      fake.tick();
    }

    expect(fake.scrolls).toEqual([400, 500, 600, 700, 800]);
    expect(controller.getStatus().stepCount).toBe(5);
  });

  it("falls back to a usable step distance when the page reports no viewport", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    fake.setViewportHeight(0);
    controller.start();

    queueStep(fake, FORWARD, 0.5);
    fake.tick();

    expect(fake.scrolls[0]).toBeGreaterThan(0);
  });

  it("waits a freshly randomized 1-15 seconds before every scroll", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });

    fake.queueRandoms(0);
    controller.start();
    expect(fake.lastDelay()).toBe(1_000);

    queueStep(fake, FORWARD, 0.5, 1);
    fake.discover(1);
    fake.tick();
    expect(fake.lastDelay()).toBe(15_000);
  });

  it("occasionally scrolls slightly backwards and never twice in a row", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start();

    // A freshly opened page has nothing above it to revisit.
    queueStep(fake, REVERSE);
    fake.discover(4);
    fake.tick();
    expect(fake.scrolls[0]).toBeGreaterThan(0);

    queueStep(fake, REVERSE);
    fake.tick();
    const reverse = fake.scrolls[1] ?? 0;
    expect(reverse).toBeLessThan(0);
    expect(Math.abs(reverse)).toBeGreaterThanOrEqual(VIEWPORT * SCROLL_LIMITS.minReverseRatio);
    expect(Math.abs(reverse)).toBeLessThanOrEqual(VIEWPORT * SCROLL_LIMITS.maxReverseRatio);

    queueStep(fake, REVERSE);
    fake.tick();
    expect(fake.scrolls[2]).toBeGreaterThan(0);
  });

  it("does not count a reverse move as a step without new accounts", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start();

    queueStep(fake, FORWARD);
    fake.tick();
    queueStep(fake, REVERSE);
    fake.tick();
    expect(controller.getStatus().noGrowthSteps).toBe(1);

    queueStep(fake, FORWARD);
    fake.tick();

    expect(controller.getStatus().noGrowthSteps).toBe(1);
  });

  it("does not scroll a hidden tab and pauses once it stays hidden for 45s", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start();
    fake.setVisible(false);

    fake.tick();
    expect(fake.scrolls).toEqual([]);
    expect(controller.getStatus()).toMatchObject({ status: "running", pauseReason: null });
    expect(fake.lastDelay()).toBeGreaterThanOrEqual(SCROLL_LIMITS.minVisibilityPollMs);
    expect(fake.lastDelay()).toBeLessThanOrEqual(SCROLL_LIMITS.maxVisibilityPollMs);

    for (let index = 0; index < 200 && controller.getStatus().status === "running"; index += 1) {
      fake.tick();
    }

    expect(controller.getStatus()).toMatchObject({ status: "paused", pauseReason: "hidden" });
    expect(fake.scrolls).toEqual([]);
  });

  it("resumes on its own once the hidden tab becomes visible again", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start();
    fake.setVisible(false);
    for (let index = 0; index < 200 && controller.getStatus().status === "running"; index += 1) {
      fake.tick();
    }
    expect(controller.getStatus().pauseReason).toBe("hidden");

    fake.setVisible(true);
    fake.tick();
    expect(controller.getStatus()).toMatchObject({ status: "running", pauseReason: null });

    queueStep(fake, FORWARD);
    fake.tick();
    expect(fake.scrolls).toEqual([600]);
  });

  it("lets a user pause replace an automatic hidden pause and cancels the auto-resume", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start();
    fake.setVisible(false);
    for (let index = 0; index < 200 && controller.getStatus().status === "running"; index += 1) {
      fake.tick();
    }
    expect(controller.getStatus().pauseReason).toBe("hidden");

    controller.pause("user");

    expect(controller.getStatus()).toMatchObject({ status: "paused", pauseReason: "user" });
    expect(fake.pending).toBeNull();

    fake.setVisible(true);
    fake.advance(SCROLL_LIMITS.hiddenGraceMs);

    expect(controller.getStatus()).toMatchObject({ status: "paused", pauseReason: "user" });
    expect(fake.scrolls).toEqual([]);
  });

  it("retargets a hidden pause when the worker pauses for a lost account", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start();
    fake.setVisible(false);
    for (let index = 0; index < 200 && controller.getStatus().status === "running"; index += 1) {
      fake.tick();
    }

    controller.pause("auth");

    expect(controller.getStatus()).toMatchObject({ status: "paused", pauseReason: "auth" });
    expect(fake.pending).toBeNull();

    fake.setVisible(true);

    expect(controller.getStatus()).toMatchObject({ status: "paused", pauseReason: "auth" });
  });

  it("refuses to turn an existing pause into a self-resuming hidden pause", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start();
    controller.pause("user");

    controller.pause("hidden");

    expect(controller.getStatus()).toMatchObject({ status: "paused", pauseReason: "user" });
    expect(fake.pending).toBeNull();
  });

  it("ignores a pause that repeats the reason already in effect", () => {
    const fake = createFakeEnvironment();
    const reports: ScrollStatus[] = [];
    const controller = createScrollController({
      env: fake.env,
      onStatus: (status) => reports.push(status),
    });
    controller.start();
    controller.pause("user");
    const reported = reports.length;

    controller.pause("user");

    expect(reports).toHaveLength(reported);
    expect(controller.getStatus()).toMatchObject({ status: "paused", pauseReason: "user" });
  });

  it("ignores a pause once the round has already ended", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start();
    controller.stop();

    controller.pause("user");

    expect(controller.getStatus()).toMatchObject({ status: "stopped", pauseReason: null });
    expect(fake.pending).toBeNull();
  });

  it("stays paused while hidden when the user paused the round", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start();
    controller.pause("user");

    expect(fake.pending).toBeNull();
    fake.setVisible(false);
    fake.advance(SCROLL_LIMITS.hiddenGraceMs * 2);

    expect(controller.getStatus()).toMatchObject({ status: "paused", pauseReason: "user" });
  });

  it("pauses after discovering the configured number of new accounts", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    fake.discover(40);
    controller.start(100);

    for (let step = 0; step < 10 && controller.getStatus().status === "running"; step += 1) {
      queueStep(fake, FORWARD);
      fake.discover(10);
      fake.tick();
    }

    expect(controller.getStatus()).toMatchObject({
      status: "paused",
      pauseReason: "budget",
      discoveredCount: 140,
    });
    expect(fake.pending).toBeNull();
  });

  it("clamps a runtime target below 100", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start(1);

    for (let count = 0; count < 99; count += 1) {
      queueStep(fake, FORWARD);
      fake.discover(1);
      fake.tick();
    }
    expect(controller.getStatus().status).toBe("running");

    queueStep(fake, FORWARD);
    fake.discover(1);
    fake.tick();
    expect(controller.getStatus()).toMatchObject({ status: "paused", pauseReason: "budget" });
  });

  it("does not stop merely because 120 steps or 8 active minutes elapsed", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start(5_000);

    for (let count = 0; count < 121; count += 1) {
      queueStep(fake, FORWARD, 0.5, 1);
      fake.discover(1);
      fake.tick();
    }

    expect(controller.getStatus()).toMatchObject({ status: "running", stepCount: 121 });
  });

  it("uses a fresh discovery baseline for the next round", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });

    for (let round = 0; round < 2; round += 1) {
      controller.start(100);
      for (let count = 0; count < 100; count += 1) {
        queueStep(fake, FORWARD);
        fake.discover(1);
        fake.tick();
      }
      expect(controller.getStatus()).toMatchObject({ status: "paused", pauseReason: "budget" });
    }

    expect(controller.getStatus().discoveredCount).toBe(200);
  });

  it("ends the round after five steps without new accounts", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start();

    runUntilRoundEnds(fake, controller, () => {
      queueStep(fake, FORWARD);
    });

    expect(controller.getStatus()).toMatchObject({
      status: "completed",
      pauseReason: "stalled",
      noGrowthSteps: SCROLL_LIMITS.maxNoGrowthSteps,
      likelyComplete: true,
    });
    expect(fake.scrolls).toHaveLength(SCROLL_LIMITS.maxNoGrowthSteps);
    expect(fake.pending).toBeNull();
  });

  it("resets the no-growth streak when new accounts arrive", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start();

    queueStep(fake, FORWARD);
    fake.tick();
    queueStep(fake, FORWARD);
    fake.tick();
    expect(controller.getStatus().noGrowthSteps).toBe(1);

    fake.discover(9);
    queueStep(fake, FORWARD);
    fake.tick();

    expect(controller.getStatus()).toMatchObject({
      status: "running",
      noGrowthSteps: 0,
      discoveredCount: 9,
    });
  });

  it("cancels pending work on stop and ignores a timer that already fired", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start();
    const pending = fake.pending;

    controller.stop();

    expect(fake.cancelled).toEqual([pending?.id]);
    expect(fake.pending).toBeNull();
    expect(controller.getStatus()).toMatchObject({ status: "stopped", pauseReason: null });

    pending?.callback();

    expect(fake.scrolls).toEqual([]);
    expect(fake.pending).toBeNull();
  });

  it("pause cancels the pending step and resume schedules a fresh one", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start();
    queueStep(fake, FORWARD);
    fake.discover(2);
    fake.tick();
    const pendingId = fake.pending?.id;

    controller.pause("user");

    expect(fake.cancelled).toContain(pendingId);
    expect(fake.pending).toBeNull();
    expect(controller.getStatus()).toMatchObject({ status: "paused", pauseReason: "user" });

    controller.resume();

    expect(controller.getStatus()).toMatchObject({ status: "running", pauseReason: null });
    expect(fake.lastDelay()).toBeGreaterThanOrEqual(SCROLL_LIMITS.minPauseMs);
  });

  it("still scrolls after a long user pause", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start();
    controller.pause("user");

    fake.advance(8 * 60_000);
    controller.resume();
    queueStep(fake, FORWARD);
    fake.discover(1);
    fake.tick();

    expect(fake.scrolls).toHaveLength(1);
    expect(controller.getStatus().status).toBe("running");
  });

  it("opens a new round window when the user continues after the budget pause", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start(100);
    for (let count = 0; count < 100; count += 1) {
      queueStep(fake, FORWARD);
      fake.discover(1);
      fake.tick();
    }
    expect(controller.getStatus().pauseReason).toBe("budget");

    controller.resume();

    expect(controller.getStatus()).toMatchObject({
      status: "running",
      pauseReason: null,
      stepCount: 0,
      noGrowthSteps: 0,
    });
  });

  it("ignores start while a round is already running", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    controller.start();
    const pending = fake.pending;

    controller.start();

    expect(fake.pending).toBe(pending);
    expect(fake.delays).toHaveLength(1);
  });

  it("ignores resume unless the round is paused", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });

    controller.resume();
    expect(fake.pending).toBeNull();
    expect(controller.getStatus().status).toBe("idle");

    controller.start();
    controller.stop();
    controller.resume();

    expect(controller.getStatus().status).toBe("stopped");
    expect(fake.pending).toBeNull();
  });

  it("reports each transition as a detached status snapshot", () => {
    const fake = createFakeEnvironment();
    const reports: ScrollStatus[] = [];
    const controller = createScrollController({
      env: fake.env,
      onStatus: (status) => reports.push(status),
    });

    controller.start();
    queueStep(fake, FORWARD);
    fake.discover(6);
    fake.tick();
    controller.stop();

    expect(reports[0]).toMatchObject({ status: "running", stepCount: 0, discoveredCount: 0 });
    expect(reports[1]).toMatchObject({ status: "running", stepCount: 1, discoveredCount: 6 });
    expect(reports[reports.length - 1]).toMatchObject({ status: "stopped" });

    const first = reports[0];
    if (first !== undefined) {
      first.stepCount = 99;
    }

    expect(controller.getStatus().stepCount).toBe(1);
  });

  it("reports the accounts the environment has discovered so far", () => {
    const fake = createFakeEnvironment();
    const controller = createScrollController({ env: fake.env });
    fake.discover(7);

    controller.start();

    expect(controller.getStatus().discoveredCount).toBe(7);
  });
});
