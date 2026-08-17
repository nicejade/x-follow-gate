/**
 * The `window.postMessage` contract between the MAIN and ISOLATED worlds.
 *
 * It lives in its own module because both worlds must agree on the literals
 * while neither may import the other: `main-world.ts` installs page observers on
 * import, and `isolated.ts` is the only world that may touch Chrome APIs.
 *
 * Messages travel through the page, so the page can read and forge them. The
 * receiving side treats every field as untrusted input.
 */

import type { FollowingUser } from "@/shared/types";

export const MESSAGE_SOURCE = "follow-gate";
export const FOLLOWING_PAGE_DATA = "FOLLOWING_PAGE_DATA";

/** The only message shape the MAIN world emits. */
export interface FollowingPageDataMessage {
  source: typeof MESSAGE_SOURCE;
  type: typeof FOLLOWING_PAGE_DATA;
  users: FollowingUser[];
}
