// The home page's header stays at the top while the list scrolls under it (.is-sticky), and once the page
// has scrolled it tucks away the household line and your name (.is-compact) to give the list the room. --app-header-h is its height, so the sticky add box sits just under it. Without script,
// the header scrolls away as before.
const header = document.querySelector(".app-header");
if (header) {
  const root = document.documentElement;
  new ResizeObserver(([entry]) => root.style.setProperty("--app-header-h", `${entry.borderBoxSize[0].blockSize}px`)).observe(header, { box: "border-box" });
  header.classList.add("is-sticky");
  // Two thresholds: compacting the header moves the page up a little, and that mustn't flip it straight back.
  let queued = false;
  const update = () => {
    queued = false;
    if (scrollY > 48) header.classList.add("is-compact");
    else if (scrollY < 8) header.classList.remove("is-compact");
  };
  addEventListener("scroll", () => queued || ((queued = true), requestAnimationFrame(update)), { passive: true });
  update();
}
