// Home page: switch lists (the tabs, the phone bar, the More sheet, project / where / tag filters, "Show all")
// without reloading the page. A click on a link to "/?…" is taken over: the address bar changes (so Back and
// Forward work, see fromLocation), and the page opens a new live-update stream for that list, which renders it
// at once and replaces the old stream (views/pages/home.eta does the @get). Anything else, or a click with a
// modifier key, is left to the browser, and without script every link loads as usual.

const LIST_KEYS = ["view", "project", "context", "tag"];

/** @param {MouseEvent} evt  @returns {{view: string, project: string, context: string, tag: string, query: string} | null} */
function fromClick(evt) {
  if (evt.defaultPrevented || evt.button !== 0 || evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey) return null;
  const link = evt.target instanceof Element ? evt.target.closest("a[href]") : null;
  if (!link || link.target || link.hasAttribute("download")) return null;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || url.pathname !== "/" || url.hash) return null;
  evt.preventDefault();
  link.closest("dialog")?.close();
  if (url.href !== location.href) history.pushState(null, "", url);
  return show(url);
}

/** Back or Forward: show whichever list the address bar now names. */
function fromLocation() {
  return show(new URL(location.href));
}

function show(url) {
  const list = Object.fromEntries(LIST_KEYS.map((key) => [key, url.searchParams.get(key) ?? ""]));
  const query = (values) => new URLSearchParams(Object.entries(values).filter(([, v]) => v)).toString();
  // The More sheet isn't re-rendered (so a live update can't close it), so point its links at the new filters here.
  for (const a of document.querySelectorAll('#more-views a[href^="/?"]')) {
    const view = new URL(a.href).searchParams.get("view");
    a.href = `/?${query({ ...list, view })}`;
    if (view === (list.view || "mine")) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  scrollTo({ top: 0 });
  return { ...list, query: query(list) };
}

window.listNav = { fromClick, fromLocation };
