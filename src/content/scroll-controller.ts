/**
 * Human-like progressive scrolling for the Following timeline.
 *
 * The extension never pages the Following API itself. It scrolls the page the
 * user is looking at and lets X load the next chunk for its own rendering, which
 * is the only read path the design allows. Everything here therefore optimizes
 * for looking like a person reading a list, and for stopping early rather than
 * pushing:
 *
 * - one step at a time, each scheduling exactly one successor with a freshly
 *   randomized delay, so there is no periodic timer to fingerprint;
 * - no work at all while the tab is hidden, and a pause once it stays hidden;
 * - three independent round budgets (wall time, steps, silent steps), any of
 *   which ends the round.
 *
 * Every capability comes from the injected `ScrollEnvironment`, so the whole
 * state machine is deterministic under test.
 */

import type { ScrollStatus, SyncPauseReason, SyncStatus } from "@/shared/types";

export interface ScrollEnvironment {
  now(): number;
  random(): number;
  isVisible(): boolean;
  /** Height of the visible area; every step is a fraction of it. */
  viewportHeight(): number;
  /** Accounts known so far. Growth is the only signal that scrolling still pays off. */
  measureDiscovered(): number;
  scrollBy(deltaY: number): void;
  schedule(callback: () => void, delayMs: number): number;
  cancel(timerId: number): void;
}

export interface ScrollLimits {
  /** Forward step distance as a fraction of the viewport. */
  minStepRatio: number;
  maxStepRatio: number;
  /** Chance that an eligible step drifts back up instead of down. */
  reverseProbability: number;
  minReverseRatio: number;
  maxReverseRatio: number;
  minPauseMs: number;
  maxPauseMs: number;
  /** Chance that a pause becomes a long "reading" pause. */
  longPauseProbability: number;
  minLongPauseMs: number;
  maxLongPauseMs: number;
  /** How long a hidden tab is tolerated before the round pauses. */
  hiddenGraceMs: number;
  minVisibilityPollMs: number;
  maxVisibilityPollMs: number;
  /** Round budgets; whichever is reached first ends the round. */
  maxRoundMs: number;
  maxSteps: number;
  maxNoGrowthSteps: number;
}

export const SCROLL_LIMITS: Readonly<ScrollLimits> = Object.freeze({
  minStepRatio: 0.4,
  maxStepRatio: 0.8,
  reverseProbability: 0.12,
  minReverseRatio: 0.05,
  maxReverseRatio: 0.15,
  minPauseMs: 1_500,
  maxPauseMs: 4_000,
  longPauseProbability: 0.15,
  minLongPauseMs: 6_000,
  maxLongPauseMs: 12_000,
  hiddenGraceMs: 45_000,
  minVisibilityPollMs: 800,
  maxVisibilityPollMs: 1_600,
  maxRoundMs: 8 * 60_000,
  maxSteps: 120,
  maxNoGrowthSteps: 5,
});

export interface ScrollControllerOptions {
  env: ScrollEnvironment;
  /** Called on every transition; the worker forwards it as `SCROLL_STATUS`. */
  onStatus?: (status: ScrollStatus) => void;
  limits?: Partial<ScrollLimits>;
}

export interface ScrollController {
  start(): void;
  pause(reason: SyncPauseReason): void;
  resume(): void;
  stop(): void;
  getStatus(): ScrollStatus;
}

/** Used when the page reports an unusable viewport height. */
const FALLBACK_VIEWPORT_HEIGHT = 800;

interface RoundState {
  startedAt: number | null;
  /** When the round last entered `running`; `null` while it is not. */
  resumedAt: number | null;
  /** Scrolling time already spent. Paused time never counts against the budget. */
  activeMs: number;
  stepCount: number;
  discoveredCount: number;
  /** Account count at the last judged forward step. */
  growthBaseline: number;
  noGrowthSteps: number;
  lastGrowthAt: number | null;
  hiddenSince: number | null;
  likelyComplete: boolean;
  lastStepWasReverse: boolean;
  /** A forward step is judged on the next tick, once the page had time to load. */
  awaitingGrowth: boolean;
}

function createRound(): RoundState {
  return {
    startedAt: null,
    resumedAt: null,
    activeMs: 0,
    stepCount: 0,
    discoveredCount: 0,
    growthBaseline: 0,
    noGrowthSteps: 0,
    lastGrowthAt: null,
    hiddenSince: null,
    likelyComplete: false,
    lastStepWasReverse: false,
    awaitingGrowth: false,
  };
}

export function createScrollController(options: ScrollControllerOptions): ScrollController {
  const { env, onStatus } = options;
  const limits: ScrollLimits = { ...SCROLL_LIMITS, ...options.limits };

  let status: SyncStatus = "idle";
  let pauseReason: SyncPauseReason | null = null;
  let timerId: number | null = null;
  let round = createRound();

  /** A page-supplied random source is still input: keep it inside [0, 1]. */
  function sample(): number {
    const value = env.random();

    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
  }

  function between(min: number, max: number): number {
    return min + (max - min) * sample();
  }

  function viewportHeight(): number {
    const height = env.viewportHeight();

    return Number.isFinite(height) && height > 0 ? height : FALLBACK_VIEWPORT_HEIGHT;
  }

  function readDiscovered(): number {
    const value = env.measureDiscovered();

    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  function snapshot(): ScrollStatus {
    return {
      status,
      stepCount: round.stepCount,
      discoveredCount: round.discoveredCount,
      noGrowthSteps: round.noGrowthSteps,
      likelyComplete: round.likelyComplete,
      pauseReason,
    };
  }

  function report(): void {
    onStatus?.(snapshot());
  }

  function clearTimer(): void {
    if (timerId !== null) {
      env.cancel(timerId);
      timerId = null;
    }
  }

  function schedule(delayMs: number): void {
    timerId = env.schedule(tick, Math.max(0, Math.round(delayMs)));
  }

  function scheduleStep(): void {
    const isLongPause = sample() < limits.longPauseProbability;

    schedule(
      isLongPause
        ? between(limits.minLongPauseMs, limits.maxLongPauseMs)
        : between(limits.minPauseMs, limits.maxPauseMs),
    );
  }

  /** Cheap watchdog used while the tab is hidden; it never scrolls. */
  function schedulePoll(): void {
    schedule(between(limits.minVisibilityPollMs, limits.maxVisibilityPollMs));
  }

  function elapsedActiveMs(): number {
    const open = status === "running" && round.resumedAt !== null ? env.now() - round.resumedAt : 0;

    return round.activeMs + Math.max(0, open);
  }

  /** Leaves `running`, banking the time spent so a pause cannot consume budget. */
  function suspend(next: SyncStatus, reason: SyncPauseReason | null): void {
    clearTimer();
    if (status === "running" && round.resumedAt !== null) {
      round.activeMs += Math.max(0, env.now() - round.resumedAt);
    }

    round.resumedAt = null;
    round.awaitingGrowth = false;
    status = next;
    pauseReason = reason;
  }

  function start(): void {
    if (status === "running") {
      return;
    }

    clearTimer();
    const now = env.now();
    const discovered = readDiscovered();
    round = {
      ...createRound(),
      startedAt: now,
      resumedAt: now,
      lastGrowthAt: now,
      discoveredCount: discovered,
      growthBaseline: discovered,
    };
    status = "running";
    pauseReason = null;

    report();
    scheduleStep();
  }

  /**
   * Pauses a running round, or retargets the reason of an already paused one.
   * Retargeting matters because `hidden` is the only pause that resumes on its
   * own: a later `user` or `auth` pause must be able to cancel that auto-resume.
   * The reverse is refused — arming the auto-resume is the controller's own
   * decision, made in `tick`, and never a caller's.
   */
  function pause(reason: SyncPauseReason): void {
    if (status !== "running" && status !== "paused") {
      return;
    }

    if (status === "paused" && (pauseReason === reason || reason === "hidden")) {
      return;
    }

    suspend("paused", reason);
    report();

    if (reason === "hidden") {
      // The round must come back on its own when the user returns to the tab.
      schedulePoll();
    }
  }

  function resume(): void {
    if (status !== "paused") {
      return;
    }

    clearTimer();
    const now = env.now();
    if (pauseReason === "budget") {
      // Continuing after a spent budget is a new round window, which is exactly
      // what the user asked for; every other pause keeps the round's counters.
      round.startedAt = now;
      round.activeMs = 0;
      round.stepCount = 0;
      round.noGrowthSteps = 0;
      round.likelyComplete = false;
      round.lastGrowthAt = now;
    }

    round.resumedAt = now;
    round.hiddenSince = null;
    round.awaitingGrowth = false;
    status = "running";
    pauseReason = null;

    report();
    scheduleStep();
  }

  function stop(): void {
    if (status === "stopped") {
      return;
    }

    suspend("stopped", null);
    round.hiddenSince = null;
    report();
  }

  /**
   * Judges the previous forward step. Returns `false` when the silent-step
   * budget ended the round, in which case the caller must not scroll again.
   */
  function judgeGrowth(): boolean {
    round.awaitingGrowth = false;

    if (round.discoveredCount > round.growthBaseline) {
      round.growthBaseline = round.discoveredCount;
      round.lastGrowthAt = env.now();
      round.noGrowthSteps = 0;

      return true;
    }

    round.noGrowthSteps += 1;
    if (round.noGrowthSteps < limits.maxNoGrowthSteps) {
      return true;
    }

    // The list ended, or the page stopped serving accounts. Either way the round
    // is over: pushing further is exactly the behaviour that gets accounts
    // flagged, and the user is told the result may be a rate limit.
    round.likelyComplete = true;
    suspend("completed", "stalled");
    report();

    return false;
  }

  function performStep(): void {
    const wantsReverse = sample() < limits.reverseProbability;
    const height = viewportHeight();

    // A round's first step has nothing above it to revisit, and two reverses in
    // a row read as a stuck page rather than as a person re-reading something.
    if (wantsReverse && round.stepCount > 0 && !round.lastStepWasReverse) {
      const distance = between(limits.minReverseRatio, limits.maxReverseRatio);
      env.scrollBy(-Math.round(height * distance));
      round.lastStepWasReverse = true;
      round.awaitingGrowth = false;

      return;
    }

    const distance = between(limits.minStepRatio, limits.maxStepRatio);
    env.scrollBy(Math.round(height * distance));
    round.lastStepWasReverse = false;
    round.awaitingGrowth = true;
  }

  function tick(): void {
    timerId = null;

    if (status === "paused" && pauseReason === "hidden") {
      if (env.isVisible()) {
        round.hiddenSince = null;
        resume();
      } else {
        schedulePoll();
      }

      return;
    }

    // A timer that fired after `stop()` or `pause()` must do nothing.
    if (status !== "running") {
      return;
    }

    if (!env.isVisible()) {
      const now = env.now();
      round.hiddenSince ??= now;
      if (now - round.hiddenSince >= limits.hiddenGraceMs) {
        pause("hidden");
      } else {
        // Scrolling a hidden tab loads nothing and only looks automated.
        schedulePoll();
      }

      return;
    }

    round.hiddenSince = null;
    round.discoveredCount = Math.max(round.discoveredCount, readDiscovered());

    if (elapsedActiveMs() >= limits.maxRoundMs || round.stepCount >= limits.maxSteps) {
      pause("budget");

      return;
    }

    if (round.awaitingGrowth && !judgeGrowth()) {
      return;
    }

    performStep();
    round.stepCount += 1;
    report();
    scheduleStep();
  }

  return { start, pause, resume, stop, getStatus: snapshot };
}
