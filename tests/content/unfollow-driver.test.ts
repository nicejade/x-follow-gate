import { detectAccount } from "@/content/auth-detector";
import { unfollowOne } from "@/content/unfollow-driver";
import type { AccountIdentity, FollowingUser } from "@/shared/types";

const OWNER: AccountIdentity = { userId: "9", handle: "self" };
const TARGET: FollowingUser = {
  userId: "2",
  handle: "alice",
  name: "Alice",
  avatarUrl: null,
  followedBy: false,
  isBlueVerified: null,
  protected: null,
  statusesCount: null,
  friendsCount: null,
  followersCount: null,
  syncedAt: 1,
};

function profileDocument(html: string): Document {
  document.documentElement.innerHTML = html;
  document.cookie = "twid=u%3D9";
  return document;
}

function shell(inner: string): string {
  return `
    <a data-testid="AppTabBar_Profile_Link" href="/self">Profile</a>
    <div data-testid="SideNavBar-AccountSwitcher">
      <div data-testid="UserAvatar-Container-self"></div>
      <span>@self</span>
    </div>
    ${inner}
  `;
}

function env(options: {
  html: string;
  pathname?: string;
  href?: string;
  clicks?: Element[];
  timeoutMs?: number;
  sleeps?: number[];
}) {
  const doc = profileDocument(shell(options.html));
  const clicks: Element[] = options.clicks ?? [];
  const sleeps: number[] = options.sleeps ?? [];

  return {
    document: doc,
    location: {
      pathname: options.pathname ?? "/alice",
      href: options.href ?? "https://x.com/alice",
    },
    detectAccount,
    click: (element: Element) => {
      clicks.push(element);
      if (element instanceof HTMLElement) {
        element.click();
      }
    },
    waitFor: async (predicate: () => boolean) => predicate(),
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    timeoutMs: options.timeoutMs ?? 20,
    clicks,
    sleeps,
  };
}

describe("unfollowOne", () => {
  afterEach(() => {
    document.documentElement.innerHTML = "";
    document.cookie = "twid=";
  });

  it("refuses when the open profile is not the queued target", async () => {
    const runtime = env({
      html: `<button data-testid="unfollow" aria-label="Following @bob">Following</button>`,
      pathname: "/bob",
      href: "https://x.com/bob",
    });

    await expect(unfollowOne(TARGET, runtime, OWNER)).resolves.toMatchObject({
      code: "target-mismatch",
      ok: false,
    });
    expect(runtime.clicks).toHaveLength(0);
  });

  it("refuses when the signed-in account is not the queue owner", async () => {
    const runtime = env({
      html: `<button data-testid="unfollow" aria-label="Following @alice">Following</button>`,
    });

    await expect(
      unfollowOne(TARGET, runtime, { userId: "99", handle: "other" }),
    ).resolves.toMatchObject({ code: "account-mismatch", ok: false });
    expect(runtime.clicks).toHaveLength(0);
  });

  it("clicks Following then the exact confirmation, at most twice", async () => {
    const runtime = env({
      html: `<button data-testid="unfollow" aria-label="Following @alice">Following</button>`,
    });
    const following = runtime.document.querySelector('[data-testid="unfollow"]');
    following?.addEventListener("click", () => {
      runtime.document.body.insertAdjacentHTML(
        "beforeend",
        `<div data-testid="confirmationSheetDialog" role="dialog">
           <button data-testid="confirmationSheetConfirm">Unfollow</button>
         </div>`,
      );
    });
    const originalWait = runtime.waitFor;
    runtime.waitFor = async (predicate) => {
      if (runtime.clicks.length === 1) {
        const confirm = runtime.document.querySelector('[data-testid="confirmationSheetConfirm"]');
        confirm?.addEventListener("click", () => {
          following?.remove();
          runtime.document.querySelector('[data-testid="confirmationSheetDialog"]')?.remove();
          runtime.document.body.insertAdjacentHTML(
            "beforeend",
            `<button data-testid="follow" aria-label="Follow @alice">Follow</button>`,
          );
        });
      }
      return originalWait(predicate);
    };

    await expect(unfollowOne(TARGET, runtime, OWNER)).resolves.toMatchObject({
      code: "success",
      ok: true,
    });
    expect(runtime.clicks).toHaveLength(2);
  });

  it("dwells on the confirm sheet using the settings interval before clicking Unfollow", async () => {
    const runtime = env({
      html: `<button data-testid="unfollow" aria-label="Following @alice">Following</button>`,
    });
    const following = runtime.document.querySelector('[data-testid="unfollow"]');
    following?.addEventListener("click", () => {
      runtime.document.body.insertAdjacentHTML(
        "beforeend",
        `<div data-testid="confirmationSheetDialog" role="dialog">
           <button data-testid="confirmationSheetConfirm">Unfollow</button>
         </div>`,
      );
    });
    const originalWait = runtime.waitFor;
    runtime.waitFor = async (predicate) => {
      if (runtime.clicks.length === 1) {
        const confirm = runtime.document.querySelector('[data-testid="confirmationSheetConfirm"]');
        confirm?.addEventListener("click", () => {
          following?.remove();
          runtime.document.querySelector('[data-testid="confirmationSheetDialog"]')?.remove();
          runtime.document.body.insertAdjacentHTML(
            "beforeend",
            `<button data-testid="follow" aria-label="Follow @alice">Follow</button>`,
          );
        });
      }
      return originalWait(predicate);
    };

    await expect(
      unfollowOne(TARGET, runtime, OWNER, {
        interval: { minSec: 5, maxSec: 9 },
        random: () => 0,
      }),
    ).resolves.toMatchObject({ code: "success", ok: true });
    expect(runtime.sleeps).toEqual([5_000]);
    expect(runtime.clicks).toHaveLength(2);
  });

  it("falls back to the accessible name when data-testid is absent", async () => {
    const runtime = env({
      html: `<button aria-label="Following @alice">Following</button>`,
    });
    runtime.document.querySelector("button")?.addEventListener("click", () => {
      runtime.document.body.insertAdjacentHTML(
        "beforeend",
        `<div role="dialog"><button>Unfollow</button></div>`,
      );
    });
    runtime.waitFor = async (predicate) => {
      if (runtime.clicks.length === 1) {
        runtime.document
          .querySelector("div[role='dialog'] button")
          ?.addEventListener("click", () => {
            runtime.document.querySelector("button[aria-label='Following @alice']")?.remove();
            runtime.document.querySelector("div[role='dialog']")?.remove();
            runtime.document.body.insertAdjacentHTML(
              "beforeend",
              `<button aria-label="Follow @alice">Follow</button>`,
            );
          });
      }
      return predicate();
    };

    await expect(unfollowOne(TARGET, runtime, OWNER)).resolves.toMatchObject({ code: "success" });
    expect(runtime.clicks).toHaveLength(2);
  });

  it("falls back to Chinese accessible names when data-testid is absent", async () => {
    const runtime = env({
      html: `<button aria-label="正在关注 @alice">正在关注</button>`,
    });
    runtime.document.querySelector("button")?.addEventListener("click", () => {
      runtime.document.body.insertAdjacentHTML(
        "beforeend",
        `<div role="dialog">
           <button>取消关注</button>
           <button>取消</button>
         </div>`,
      );
    });
    runtime.waitFor = async (predicate) => {
      if (runtime.clicks.length === 1) {
        const confirm = [...runtime.document.querySelectorAll("div[role='dialog'] button")].find(
          (button) => button.textContent?.trim() === "取消关注",
        );
        confirm?.addEventListener("click", () => {
          runtime.document.querySelector("button[aria-label='正在关注 @alice']")?.remove();
          runtime.document.querySelector("div[role='dialog']")?.remove();
          runtime.document.body.insertAdjacentHTML(
            "beforeend",
            `<button aria-label="关注 @alice">关注</button>`,
          );
        });
      }
      return predicate();
    };

    await expect(unfollowOne(TARGET, runtime, OWNER)).resolves.toMatchObject({
      code: "success",
      ok: true,
    });
    expect(runtime.clicks).toHaveLength(2);
  });

  it("treats a Chinese Follow control as already-unfollowed", async () => {
    const runtime = env({
      html: `<button aria-label="关注 @alice">关注</button>`,
    });

    await expect(unfollowOne(TARGET, runtime, OWNER)).resolves.toMatchObject({
      code: "already-unfollowed",
      ok: true,
    });
    expect(runtime.clicks).toHaveLength(0);
  });

  it("returns already-unfollowed without clicking when the profile shows Follow", async () => {
    const runtime = env({
      html: `<button data-testid="follow" aria-label="Follow @alice">Follow</button>`,
    });

    await expect(unfollowOne(TARGET, runtime, OWNER)).resolves.toMatchObject({
      code: "already-unfollowed",
      ok: true,
    });
    expect(runtime.clicks).toHaveLength(0);
  });

  it("maps a login wall to auth-required without clicking", async () => {
    const runtime = env({
      html: `<button data-testid="loginButton">Log in</button>
             <button data-testid="unfollow">Following</button>`,
    });

    await expect(unfollowOne(TARGET, runtime, OWNER)).resolves.toMatchObject({
      code: "auth-required",
    });
    expect(runtime.clicks).toHaveLength(0);
  });

  it("maps a suspicious-activity prompt to challenge after the first click", async () => {
    const runtime = env({
      html: `<button data-testid="unfollow" aria-label="Following @alice">Following</button>`,
    });
    runtime.document.querySelector("button")?.addEventListener("click", () => {
      runtime.document.body.insertAdjacentHTML(
        "beforeend",
        `<div role="dialog">We detected unusual activity. Please verify you are not a bot.</div>`,
      );
    });

    await expect(unfollowOne(TARGET, runtime, OWNER)).resolves.toMatchObject({
      code: "challenge",
    });
    expect(runtime.clicks).toHaveLength(1);
  });

  it("maps a Chinese identity challenge sheet to challenge after the first click", async () => {
    const runtime = env({
      html: `<button aria-label="正在关注 @alice">正在关注</button>`,
    });
    runtime.document.querySelector("button")?.addEventListener("click", () => {
      runtime.document.body.insertAdjacentHTML(
        "beforeend",
        `<div role="dialog">检测到异常活动。请确认你的身份。</div>`,
      );
    });

    await expect(unfollowOne(TARGET, runtime, OWNER)).resolves.toMatchObject({
      code: "challenge",
    });
    expect(runtime.clicks).toHaveLength(1);
  });

  it("does not treat an incidental 验证 mention on the profile as a challenge", async () => {
    const runtime = env({
      html: `<p>邮箱验证已完成</p>
             <button aria-label="正在关注 @alice">正在关注</button>`,
    });
    runtime.document.querySelector("button")?.addEventListener("click", () => {
      runtime.document.body.insertAdjacentHTML(
        "beforeend",
        `<div role="dialog"><button>取消关注</button></div>`,
      );
    });
    runtime.waitFor = async (predicate) => {
      if (runtime.clicks.length === 1) {
        const confirm = [...runtime.document.querySelectorAll("div[role='dialog'] button")].find(
          (button) => button.textContent?.trim() === "取消关注",
        );
        confirm?.addEventListener("click", () => {
          runtime.document.querySelector("button[aria-label='正在关注 @alice']")?.remove();
          runtime.document.querySelector("div[role='dialog']")?.remove();
          runtime.document.body.insertAdjacentHTML(
            "beforeend",
            `<button aria-label="关注 @alice">关注</button>`,
          );
        });
      }
      return predicate();
    };

    await expect(unfollowOne(TARGET, runtime, OWNER)).resolves.toMatchObject({
      code: "success",
      ok: true,
    });
    expect(runtime.clicks).toHaveLength(2);
  });

  it("returns control-missing when no Following button exists", async () => {
    const runtime = env({ html: `<div>profile</div>` });

    await expect(unfollowOne(TARGET, runtime, OWNER)).resolves.toMatchObject({
      code: "control-missing",
    });
    expect(runtime.clicks).toHaveLength(0);
  });

  it("returns confirmation-missing when the dialog never appears", async () => {
    const runtime = env({
      html: `<button data-testid="unfollow" aria-label="Following @alice">Following</button>`,
    });

    await expect(unfollowOne(TARGET, runtime, OWNER)).resolves.toMatchObject({
      code: "confirmation-missing",
    });
    expect(runtime.clicks).toHaveLength(1);
  });

  it("maps a rate-limit sheet to rate-limited after the first click", async () => {
    const runtime = env({
      html: `<button data-testid="unfollow" aria-label="Following @alice">Following</button>`,
    });
    runtime.document.querySelector("button")?.addEventListener("click", () => {
      runtime.document.body.insertAdjacentHTML(
        "beforeend",
        `<div role="dialog">Rate limit exceeded. Try again later.</div>`,
      );
    });

    await expect(unfollowOne(TARGET, runtime, OWNER)).resolves.toMatchObject({
      code: "rate-limited",
    });
    expect(runtime.clicks).toHaveLength(1);
  });
});
