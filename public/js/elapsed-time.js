// <elapsed-time since="ISO time">12 min</elapsed-time>: how long ago something started, kept current each
// minute ("on it for 12 min" on the Working on now card). The server renders the text as of the page load, so
// without script it's still right, just not ticking.
import { elapsedLabel } from "./lib/dates.js";

class ElapsedTime extends HTMLElement {
  connectedCallback() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 15_000);
  }

  disconnectedCallback() {
    clearInterval(this.timer);
  }

  tick() {
    const since = Date.parse(this.getAttribute("since") ?? "");
    if (!Number.isNaN(since)) this.textContent = elapsedLabel(Date.now() - since);
  }
}

customElements.define("elapsed-time", ElapsedTime);
