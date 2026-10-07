// <task-picker>: wraps a <select> whose tasks are grouped in <optgroup>s (views/partials/task-edit.eta) and turns it
// into a button that opens a bottom sheet: a search box, then the tasks under their group headings, then the
// options outside any group ("➕ New task…", "No, …"). Picking one sets the select and fires `change`, so the form
// saves exactly as if the select had been used. The select stays in the form (hidden) as the field that's saved,
// and without script it's just the grouped dropdown. Each option's data-meta (due · who · where) shows under it.

let sheets = 0;

class TaskPicker extends HTMLElement {
  connectedCallback() {
    this.select = this.querySelector("select");
    if (!this.select || this.button) return;
    this.select.hidden = true;

    this.button = Object.assign(document.createElement("button"), { type: "button", className: "task-picker-button" });
    this.button.setAttribute("aria-haspopup", "dialog");
    this.button.addEventListener("click", () => this.open());
    this.select.after(this.button);
    this.showChoice();
    if (this.select.autofocus) requestAnimationFrame(() => this.button.focus());

    this.sheet = this.buildSheet();
    this.append(this.sheet);
  }

  /** The button says what's picked, like the select did. */
  showChoice() {
    const picked = this.select.selectedOptions[0];
    this.button.textContent = picked?.textContent ?? "";
    const label = this.closest("label")?.firstChild?.textContent.trim();
    this.button.setAttribute("aria-label", label ? `${label} ${picked?.textContent ?? ""}` : picked?.textContent ?? "");
  }

  buildSheet() {
    const id = `task-picker-${++sheets}`;
    const dialog = document.createElement("dialog");
    dialog.className = "sheet task-picker";
    dialog.setAttribute("aria-labelledby", `${id}-title`);
    dialog.setAttribute("closedby", "any");
    dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());
    // Inside the form, so nothing in here may submit it or count as a field.
    dialog.innerHTML = `
      <div class="sheet-body">
        <h2 id="${id}-title">Pick the task to do first</h2>
        <input type="search" class="task-picker-search" placeholder="Search tasks" aria-label="Search tasks" autocomplete="off" enterkeyhint="go">
        <div class="task-picker-list" role="list"></div>
        <p class="hint task-picker-none" hidden></p>
        <div class="task-picker-extra"></div>
        <button type="button" class="button task-picker-close">Close</button>
      </div>`;
    const list = dialog.querySelector(".task-picker-list");
    const extra = dialog.querySelector(".task-picker-extra");

    for (const child of this.select.children) {
      if (child.tagName === "OPTGROUP") {
        const group = document.createElement("section");
        group.className = "task-picker-group";
        group.setAttribute("role", "listitem");
        const heading = document.createElement("h3");
        heading.textContent = child.label;
        group.append(heading, ...[...child.children].map((o) => this.choice(o)));
        list.append(group);
      } else {
        // "No, ready when you are" goes last, under "➕ New task…": the way out, after the ways in.
        const button = this.choice(child);
        if (child.value === "") extra.append(button);
        else extra.prepend(button);
      }
    }
    if (!list.children.length) list.innerHTML = `<p class="hint">No other open tasks yet. Add the one that has to happen first with “➕ New task…”.</p>`;

    const search = dialog.querySelector("input");
    search.addEventListener("input", () => this.filter(search.value));
    // Enter picks the first match; it mustn't reach the form, which would blur the box instead.
    search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      dialog.querySelector(".task-picker-group button:not([hidden])")?.click();
    });
    dialog.querySelector(".task-picker-close").addEventListener("click", () => dialog.close());
    return dialog;
  }

  /** One choice in the sheet: the option's text, its details underneath, and a tick if it's the one picked. */
  choice(option) {
    const button = Object.assign(document.createElement("button"), { type: "button", className: "task-picker-choice" });
    button.dataset.value = option.value;
    const title = Object.assign(document.createElement("span"), { textContent: option.textContent });
    button.append(title);
    if (option.dataset.meta) button.append(Object.assign(document.createElement("span"), { className: "hint", textContent: option.dataset.meta }));
    button.dataset.search = `${option.textContent} ${option.dataset.meta ?? ""} ${option.parentElement.label ?? ""}`.toLowerCase();
    button.addEventListener("click", () => this.pick(option.value));
    return button;
  }

  open() {
    const value = this.select.value;
    for (const b of this.sheet.querySelectorAll(".task-picker-choice")) b.setAttribute("aria-current", String(b.dataset.value === value));
    const search = this.sheet.querySelector("input");
    search.value = "";
    this.filter("");
    this.sheet.showModal();
    // On a phone, the keyboard would cover half the list; only jump into the search box with a real keyboard.
    if (matchMedia("(hover: hover) and (pointer: fine)").matches) search.focus();
  }

  /** Shows the tasks whose title, details or group match every word typed, and hides groups left empty. */
  filter(text) {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const group of this.sheet.querySelectorAll(".task-picker-group")) {
      let any = false;
      for (const b of group.querySelectorAll("button")) {
        b.hidden = !words.every((w) => b.dataset.search.includes(w));
        if (b.hidden) continue;
        any = true;
        shown++;
      }
      group.hidden = !any;
    }
    const none = this.sheet.querySelector(".task-picker-none");
    none.hidden = !words.length || shown > 0;
    none.textContent = `No open tasks match “${text.trim()}”. Pick “➕ New task…” to add it.`;
  }

  pick(value) {
    this.sheet.close();
    if (this.select.value === value) return;
    this.select.value = value;
    this.showChoice();
    this.select.dispatchEvent(new Event("change", { bubbles: true }));
    // "➕ New task…" shows the box for its name (CSS :has on the select); start typing there.
    if (value === "new") requestAnimationFrame(() => this.select.form?.elements.newBlocker?.focus());
  }
}

customElements.define("task-picker", TaskPicker);
