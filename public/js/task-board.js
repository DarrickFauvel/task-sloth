// <task-board> (views/partials/task-board.eta): drag a card to another column to move it there. Dropping just
// submits the card's own "Move to" form for that column, so a drop and a tap on "Move to" do the same thing (and
// the server re-renders the board). Listeners sit on the board itself, so live updates that re-render the cards
// inside it don't lose them.
class TaskBoard extends HTMLElement {
  connectedCallback() {
    this.addEventListener("dragstart", (e) => {
      const card = e.target.closest?.(".board-card");
      if (!card) return;
      this.dragging = card;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", card.dataset.task);
      requestAnimationFrame(() => card.classList.add("is-dragging"));
    });
    this.addEventListener("dragend", () => {
      this.dragging?.classList.remove("is-dragging");
      this.dragging = null;
      this.mark(null);
    });
    this.addEventListener("dragover", (e) => {
      const col = this.target(e);
      if (!col) return;
      e.preventDefault(); // allows the drop
      e.dataTransfer.dropEffect = "move";
      this.mark(col);
    });
    this.addEventListener("dragleave", (e) => {
      if (!this.contains(e.relatedTarget)) this.mark(null);
    });
    this.addEventListener("drop", (e) => {
      const col = this.target(e);
      if (!col) return;
      e.preventDefault();
      const form = this.dragging.querySelector(`form[data-move="${col.dataset.column}"]`);
      this.mark(null);
      form?.requestSubmit();
    });
  }

  /** The column under the pointer, if the card being dragged isn't already in it. */
  target(e) {
    const col = e.target.closest?.(".board-col");
    return col && this.dragging && !col.contains(this.dragging) ? col : null;
  }

  mark(col) {
    for (const c of this.querySelectorAll(".board-col.is-over")) if (c !== col) c.classList.remove("is-over");
    col?.classList.add("is-over");
  }
}

customElements.define("task-board", TaskBoard);
