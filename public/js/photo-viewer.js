// The photo viewer (views/partials/photo-viewer.eta). Tapping a link with data-photos opens it:
//   data-photos="<url>"  a JSON list of the task's photos, [{ full, tiny }] (a task row's thumbnail stack), or
//   data-photos=""        the photos are the page's own [data-photos] links, in order (task page thumbnails), or
//   data-photos="self"    just this link's photo (a checklist item's).
// data-index says which photo to start on: on the tapped element inside the link (one thumbnail of a
// row's stack), else on the link itself. Arrows, the arrow keys, swiping and the thumbnail strip along the
// bottom move between photos; ×, Esc and tapping outside the photo close it. The opening and each change of
// photo are animated in CSS.
const dialog = document.getElementById("photo-viewer");
const img = dialog.querySelector("img");
const count = dialog.querySelector(".viewer-count");
const strip = dialog.querySelector(".viewer-strip");
let photos = [];
let index = 0;

document.addEventListener("click", async (e) => {
  const link = e.target.closest("a[data-photos]");
  if (!link || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  const source = link.dataset.photos;
  const start = Number(e.target.closest("[data-index]")?.dataset.index ?? 0);
  if (source === "self") return open([{ full: link.href, tiny: link.querySelector("img")?.src ?? link.href }], 0);
  if (!source) {
    const links = [...document.querySelectorAll("a[data-photos='']")];
    return open(links.map((a) => ({ full: a.href, tiny: a.querySelector("img")?.src ?? a.href })), start);
  }
  const res = await fetch(source, { headers: { Accept: "application/json" } }).catch(() => null);
  const list = res?.ok ? (await res.json()).photos : null;
  if (list?.length) open(list, start);
  else location.assign(link.href); // the task page shows them another way
});

function open(list, start) {
  photos = list;
  dialog.classList.toggle("is-single", photos.length === 1);
  strip.replaceChildren(
    ...photos.map((p, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.go = i;
      button.setAttribute("aria-label", `Photo ${i + 1}`);
      const thumb = document.createElement("img");
      thumb.src = p.tiny;
      thumb.alt = "";
      button.append(thumb);
      return button;
    }),
  );
  show(start, 0);
  dialog.showModal();
  markStrip("instant");
}

/** Highlights the current photo's thumbnail and scrolls the strip to center it. */
function markStrip(behavior = "smooth") {
  for (const b of strip.children) b.toggleAttribute("aria-current", Number(b.dataset.go) === index);
  strip.children[index]?.scrollIntoView({ behavior, block: "nearest", inline: "center" });
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
  if (dialog.open) markStrip();
  // Fetch the neighbours now so moving to them is instant.
  for (const n of [index + 1, index - 1]) if (photos.length > 1) new Image().src = photos[(n + photos.length) % photos.length].full;
}

const step = (d) => photos.length > 1 && show(index + d, d);

let swiped = false; // a swipe ends in a click, which mustn't also close the viewer

dialog.addEventListener("click", (e) => {
  if (swiped) return void (swiped = false);
  const go = e.target.closest("[data-go]")?.dataset.go;
  if (go !== undefined) return void (Number(go) !== index && show(Number(go), Math.sign(Number(go) - index)));
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
  swiped = false;
  // Dragging the strip scrolls it; it doesn't change photo.
  [startX, startY] = e.target.closest(".viewer-strip") ? [null, null] : [e.clientX, e.clientY];
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
