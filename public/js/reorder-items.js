// <reorder-items>: wraps a checklist. Each unchecked row's grip ([data-move="<item id>"]) drags the row
// within its <ul> (its section); ↑/↓ on a focused grip move it one place. The row moves on the page
// straight away, then POST /items/:id/move saves it with the id of the row it now sits before.
// Live updates re-render the list for everyone, this page included, from what was saved.
const EDGE = 64; // px from the top or bottom of the screen where a drag starts scrolling

class ReorderItems extends HTMLElement {
  connectedCallback() {
    this.addEventListener("pointerdown", (e) => this.start(e));
    this.addEventListener("keydown", (e) => this.key(e));
  }

  /** The rows a row can trade places with: the unchecked ones in its section. */
  movable(row) {
    return [...row.parentElement.children].filter((li) => li.querySelector("[data-move]"));
  }

  start(e) {
    const grip = e.target.closest("[data-move]");
    if (!grip || e.button !== 0) return;
    e.preventDefault();
    const row = grip.closest("li");
    const before = this.nextOf(row);
    const grabY = e.clientY - row.getBoundingClientRect().top;
    let y = e.clientY;
    grip.setPointerCapture(e.pointerId);
    row.classList.add("is-dragging");

    const place = () => {
      // Swap with a neighbor once the pointer passes its middle, then keep the row under the pointer.
      row.style.transform = "";
      for (const other of this.movable(row)) {
        if (other === row) continue;
        const r = other.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const isAbove = other.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING;
        if (isAbove && y < mid) { other.before(row); break; }
        if (!isAbove && y > mid) other.after(row);
      }
      // Stay inside the section, so the row never slides over its heading or the next section.
      const home = row.parentElement.getBoundingClientRect(), natural = row.getBoundingClientRect();
      const top = Math.min(Math.max(y - grabY, home.top), home.bottom - natural.height);
      row.style.transform = `translateY(${top - natural.top}px)`;
    };
    // Near the screen's edge, keep scrolling while the pointer is held there.
    let frame = requestAnimationFrame(function scroll() {
      const step = y < EDGE ? -8 : y > innerHeight - EDGE ? 8 : 0;
      if (step) { scrollBy(0, step); place(); }
      frame = requestAnimationFrame(scroll);
    });
    const move = (ev) => { y = ev.clientY; place(); };
    const end = () => {
      cancelAnimationFrame(frame);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      row.classList.remove("is-dragging");
      row.style.transform = "";
      if (this.nextOf(row) !== before) this.save(row);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }

  key(e) {
    const grip = e.target.closest("[data-move]");
    if (!grip || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const row = grip.closest("li");
    const rows = this.movable(row);
    const i = rows.indexOf(row);
    const other = rows[e.key === "ArrowUp" ? i - 1 : i + 1];
    if (!other) return;
    if (e.key === "ArrowUp") other.before(row); else other.after(row);
    grip.focus();
    this.save(row);
  }

  /** The movable row after this one, or null at the end of its section. */
  nextOf(row) {
    const rows = this.movable(row);
    return rows[rows.indexOf(row) + 1] ?? null;
  }

  save(row) {
    const rows = this.movable(row);
    this.announce(`${row.querySelector(".item-text")?.textContent.trim()}: ${rows.indexOf(row) + 1} of ${rows.length}`);
    const before = this.nextOf(row)?.querySelector("[data-move]").dataset.move ?? "";
    const id = row.querySelector("[data-move]").dataset.move;
    fetch(`/items/${id}/move`, { method: "POST", body: new URLSearchParams({ before }), redirect: "manual" })
      .then((res) => { if (!res.ok && res.type !== "opaqueredirect") location.reload(); }, () => location.reload());
  }

  /** Tells screen readers where the row went. The status line is outside the checklist, so the live
      re-render that follows a move can't wipe it before it's read (see views/pages/task.eta). */
  announce(message) {
    const status = document.getElementById("reorder-status");
    if (status) status.textContent = message;
  }
}

customElements.define("reorder-items", ReorderItems);
