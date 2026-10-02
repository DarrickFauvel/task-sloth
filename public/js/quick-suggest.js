// <quick-suggest> sits next to the quick-add box (views/pages/home.eta) and suggests shortcuts as you type
// (public/js/lib/suggest.js): who and where / how after @, projects after #, tags after +, and when and repeat
// words. Tap one, or use ↑/↓ and Enter, or Tab for the first. Esc closes the list (a second Esc clears the box).
//
// The household's names come from #task-list's data-suggest, which every live update re-sends, so a project
// added a moment ago is suggested too.
import { suggestAt } from "./lib/suggest.js";

let ids = 0;

class QuickSuggest extends HTMLElement {
  connectedCallback() {
    this.input = this.parentElement.querySelector("input");
    this.list = document.createElement("ul");
    this.list.className = "suggestions";
    this.list.id = `suggestions-${++ids}`;
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", "Suggestions");
    this.list.hidden = true;
    // In the form, not beside the box, so it can span the whole add bar (the box alone is narrow on a phone).
    this.input.form.append(this.list);
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.setAttribute("aria-controls", this.list.id);
    this.input.setAttribute("aria-expanded", "false");

    this.input.addEventListener("input", () => this.update());
    this.input.addEventListener("click", () => this.update());
    this.input.addEventListener("blur", () => this.close());
    // Capture on the form, ahead of the box's own handlers: while the list is open, its keys are ours
    // (Enter mustn't add the task, Esc mustn't clear the box).
    this.input.form.addEventListener("keydown", (e) => e.target === this.input && this.key(e), true);
    this.input.form.addEventListener("submit", () => this.close());
    // pointerdown keeps the focus in the box, so the tap isn't lost to blur closing the list.
    this.list.addEventListener("pointerdown", (e) => e.preventDefault());
    this.list.addEventListener("click", (e) => {
      const option = e.target.closest("[role=option]");
      if (option) this.pick(Number(option.dataset.index));
    });
  }

  data() {
    try {
      return JSON.parse(document.getElementById("task-list")?.dataset.suggest ?? "{}");
    } catch {
      return {};
    }
  }

  update() {
    const data = this.data();
    const today = data.today ?? new Date().toISOString().slice(0, 10);
    const found = this.input.selectionStart === this.input.selectionEnd ? suggestAt(this.input.value, this.input.selectionStart, data, today) : null;
    if (!found) return this.close();
    this.found = found;
    // After @, # or + the first one is ready for Enter; for plain words ("sun…") nothing is until you arrow to it.
    this.active = found.strong ? 0 : -1;
    this.list.replaceChildren(
      ...found.items.map((s, i) => {
        const li = document.createElement("li");
        li.id = `${this.list.id}-${i}`;
        li.setAttribute("role", "option");
        li.dataset.index = String(i);
        const label = document.createElement("span");
        label.className = "suggestion-label";
        if (s.color) {
          const dot = document.createElement("span");
          dot.className = "dot";
          dot.style.background = s.color;
          label.append(dot);
        }
        label.append(s.label);
        const kind = document.createElement("span");
        kind.className = "suggestion-kind";
        kind.textContent = s.detail ? `${s.kind} · ${s.detail}` : s.kind;
        li.append(label, kind);
        return li;
      }),
    );
    this.list.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
    this.highlight();
  }

  highlight() {
    [...this.list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === this.active)));
    if (this.active >= 0) this.input.setAttribute("aria-activedescendant", `${this.list.id}-${this.active}`);
    else this.input.removeAttribute("aria-activedescendant");
  }

  close() {
    if (this.list.hidden) return;
    this.list.hidden = true;
    this.found = null;
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
  }

  key(e) {
    if (this.list.hidden || !this.found) return;
    const n = this.found.items.length;
    const stop = () => (e.preventDefault(), e.stopPropagation());
    if (e.key === "ArrowDown") (stop(), (this.active = (this.active + 1) % n), this.highlight());
    else if (e.key === "ArrowUp") (stop(), (this.active = (this.active - 1 + n) % n), this.highlight());
    else if (e.key === "Escape") (stop(), this.close());
    else if (e.key === "Tab" && !e.shiftKey) (stop(), this.pick(Math.max(this.active, 0)));
    else if (e.key === "Enter" && this.active >= 0) (stop(), this.pick(this.active));
  }

  /** Puts the suggestion in place of what was being typed, and the cursor after it. */
  pick(index) {
    const { start, end, items } = this.found ?? {};
    const s = items?.[index];
    if (!s) return;
    const value = this.input.value;
    const head = `${value.slice(0, start)}${s.insert} `;
    this.input.value = head + value.slice(end).replace(/^\s+/, "");
    this.input.setSelectionRange(head.length, head.length);
    this.input.dispatchEvent(new Event("input", { bubbles: true })); // Datastar's $quick follows the box
    this.input.focus();
  }
}

customElements.define("quick-suggest", QuickSuggest);
