import { detectAccount } from "@/content/auth-detector";

const USER_ID = "1234567890";

function setTwid(value: string): void {
  document.cookie = `twid=${value}`;
}

function clearCookies(): void {
  for (const entry of document.cookie.split(";")) {
    const name = entry.split("=")[0]?.trim();
    if (name !== undefined && name !== "") {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    }
  }
}

/** Minimal stand-in for the stable parts of the signed-in X chrome. */
function renderSignedIn(handle: string, switcherHandle = handle): void {
  document.body.innerHTML = `
    <nav role="navigation">
      <a data-testid="AppTabBar_Profile_Link" href="/${handle}" role="link">
        <span>Profile</span>
      </a>
      <div data-testid="SideNavBar-AccountSwitcher" role="button" aria-label="Account menu">
        <div data-testid="UserAvatar-Container-${switcherHandle}"></div>
        <div dir="ltr"><span>Display Name</span></div>
        <div dir="ltr"><span>@${switcherHandle}</span></div>
      </div>
    </nav>`;
}

beforeEach(() => {
  clearCookies();
  document.body.innerHTML = "";
});

afterEach(() => {
  clearCookies();
});

describe("detectAccount", () => {
  it("returns the normalized identity when the page and the cookie agree", () => {
    renderSignedIn("alice");
    setTwid(encodeURIComponent(`u=${USER_ID}`));

    expect(detectAccount(document)).toEqual({ userId: USER_ID, handle: "alice" });
  });

  it("normalizes the handle to lowercase without the leading @", () => {
    renderSignedIn("Alice_01");
    setTwid(encodeURIComponent(`u=${USER_ID}`));

    expect(detectAccount(document)).toEqual({ userId: USER_ID, handle: "alice_01" });
  });

  it("accepts a quoted cookie value", () => {
    renderSignedIn("alice");
    setTwid(encodeURIComponent(`"u=${USER_ID}"`));

    expect(detectAccount(document)?.userId).toBe(USER_ID);
  });

  it("reads the handle from the account switcher when the profile link is missing", () => {
    document.body.innerHTML = `
      <div data-testid="SideNavBar-AccountSwitcher" role="button">
        <div data-testid="UserAvatar-Container-bob"></div>
      </div>`;
    setTwid(encodeURIComponent(`u=${USER_ID}`));

    expect(detectAccount(document)).toEqual({ userId: USER_ID, handle: "bob" });
  });

  it("reads the handle from the switcher label when no avatar container exists", () => {
    document.body.innerHTML = `
      <div data-testid="SideNavBar-AccountSwitcher" role="button">
        <div dir="ltr"><span>Bob The Builder</span></div>
        <div dir="ltr"><span>@bob</span></div>
      </div>`;
    setTwid(encodeURIComponent(`u=${USER_ID}`));

    expect(detectAccount(document)?.handle).toBe("bob");
  });

  it("returns null when two page sources disagree about the handle", () => {
    renderSignedIn("alice", "bob");
    setTwid(encodeURIComponent(`u=${USER_ID}`));

    expect(detectAccount(document)).toBeNull();
  });

  it("returns null when the user id cookie is missing", () => {
    renderSignedIn("alice");

    expect(detectAccount(document)).toBeNull();
  });

  it("returns null when the user id cookie is not a numeric id", () => {
    renderSignedIn("alice");
    setTwid(encodeURIComponent("u=not-an-id"));

    expect(detectAccount(document)).toBeNull();
  });

  it("returns null when the user id cookie does not carry the expected shape", () => {
    renderSignedIn("alice");
    setTwid(USER_ID);

    expect(detectAccount(document)).toBeNull();
  });

  it("returns null when the page shows a signed-out login control", () => {
    renderSignedIn("alice");
    document.body.insertAdjacentHTML(
      "beforeend",
      `<a href="/login" data-testid="loginButton" role="link">Sign in</a>`,
    );
    setTwid(encodeURIComponent(`u=${USER_ID}`));

    expect(detectAccount(document)).toBeNull();
  });

  it("returns null when no handle source is present", () => {
    document.body.innerHTML = `<main><h1>Something else</h1></main>`;
    setTwid(encodeURIComponent(`u=${USER_ID}`));

    expect(detectAccount(document)).toBeNull();
  });

  it("ignores reserved application paths that are not profiles", () => {
    document.body.innerHTML = `
      <a data-testid="AppTabBar_Profile_Link" href="/i/flow/login" role="link">Profile</a>`;
    setTwid(encodeURIComponent(`u=${USER_ID}`));

    expect(detectAccount(document)).toBeNull();
  });

  it("rejects a handle that cannot be a real X handle", () => {
    renderSignedIn("not-a-valid-handle-because-it-is-far-too-long");
    setTwid(encodeURIComponent(`u=${USER_ID}`));

    expect(detectAccount(document)).toBeNull();
  });

  it("ignores query strings on the profile link", () => {
    document.body.innerHTML = `
      <a data-testid="AppTabBar_Profile_Link" href="/alice?ref=nav" role="link">Profile</a>`;
    setTwid(encodeURIComponent(`u=${USER_ID}`));

    expect(detectAccount(document)?.handle).toBe("alice");
  });

  it("returns null instead of throwing when the document is unreadable", () => {
    const broken = {
      querySelector: () => {
        throw new Error("detached document");
      },
      querySelectorAll: () => {
        throw new Error("detached document");
      },
      cookie: "",
    } as unknown as Document;

    expect(detectAccount(broken)).toBeNull();
  });
});
