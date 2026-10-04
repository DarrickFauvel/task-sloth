import { cleanView, VIEWS } from "./task-list.js";

/** The cookie that remembers which list someone last looked at, so other pages can lead back to it. */
export const LAST_VIEW_COOKIE = "last_view";

/** The list someone last looked at (the last_view cookie), or Mine. */
export const lastViewOf = (cookies = {}) => cleanView(cookies[LAST_VIEW_COOKIE]);

/** "← Waiting on": the way back from any page to the list you came from. */
export const backLink = (view) => ({ href: `/?view=${view}`, label: VIEWS[view] });
