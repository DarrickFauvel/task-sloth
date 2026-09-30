// The photo viewer (views/partials/photo-viewer.eta). Tapping a link with data-photos opens it:
//   data-photos="<url>"  a JSON list of the task's photos, [{ full }] (a task row's 📷 count), or
//   data-photos=""        the photos are the page's own [data-photos] links, in order (task page thumbnails).
// data-index says which photo to start on. Arrows, the arrow keys and swiping move between photos;
// ×, Esc and tapping outside the photo close it. The opening and each change of photo are animated in CSS.
const dialog = document.getElementById("photo-viewer");
const img = dialog.querySelector("img");
const count = dialog.querySelector(".viewer-count");
let photos = [];
let index = 0;

document.addEventListener("click", async (e) => {
  const link = e.target.closest("a[data-photos]");
  if (!link || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  const source = link.dataset.photos;
  const start = Number(link.dataset.index ?? 0);
  if (!source) return open([...document.querySelectorAll("a[data-photos='']")].map((a) => ({ full: a.href })), start);
  const res = await fetch(source, { headers: { Accept: "application/json" } }).catch(() => null);
  const list = res?.ok ? (await res.json()).photos : null;
  if (list?.length) open(list, start);
  else location.assign(link.href); // the task page shows them another way
});

function open(list, start) {
  photos = list;
  dialog.classList.toggle("is-single", photos.length === 1);
  show(start, 0);
  dialog.showModal();
}

/** Shows photo `i` (wrapping around); `direction` (-1, 0 or 1) picks which way it slides in. */
function show(i, direction) {
  index = (i + photos.length) % photos.length;
  img.src = photos[index].full;
  img.alt = `Photo ${index + 1} of ${photos.length}`;
  count.textContent = photos.length > 1 ? `${index + 1} / ${photos.length}` : "";
  // Restart the slide-in animation: drop the class, force a reflow, add it back.
  img.classList.remove("from-left", "from-right", "fade-in");
  void img.offsetWidth;
  img.classList.add(direction < 0 ? "from-left" : direction > 0 ? "from-right" : "fade-in");
  // Fetch the neighbours now so moving to them is instant.
  for (const n of [index + 1, index - 1]) if (photos.length > 1) new Image().src = photos[(n + photos.length) % photos.length].full;
}

const step = (d) => photos.length > 1 && show(index + d, d);

let swiped = false; // a swipe ends in a click, which mustn't also close the viewer

dialog.addEventListener("click", (e) => {
  if (swiped) return void (swiped = false);
  const action = e.target.closest("[data-viewer]")?.dataset.viewer;
  if (action === "close") dialog.close();
  else if (action === "prev") step(-1);
  else if (action === "next") step(1);
  // A tap on the dark area around the photo closes it, as closedby="any" does for the backdrop.
  else if (e.target === dialog || e.target.classList.contains("viewer-stage")) dialog.close();
});

dialog.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") step(-1);
  else if (e.key === "ArrowRight") step(1);
});

// Swipe: a mostly-sideways drag of 40px or more moves to the next or previous photo.
let startX = null;
let startY = null;
dialog.addEventListener("pointerdown", (e) => {
  [startX, startY] = [e.clientX, e.clientY];
  swiped = false;
});
dialog.addEventListener("pointerup", (e) => {
  if (startX === null) return;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  startX = null;
  swiped = Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy);
  if (swiped) step(dx < 0 ? 1 : -1);
});

dialog.addEventListener("close", () => img.removeAttribute("src"));
