// <elapsed-time since="ISO time">On it for 12 min</elapsed-time>: how long ago you started, kept current each
// minute (the Working on now card; "Just started" for the first minute). The server renders the text as of the page load, so
// without script it's still right, just not ticking.
import { onItLabel } from "./lib/dates.js";

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
    if (!Number.isNaN(since)) this.textContent = onItLabel(Date.now() - since);
  }
}

customElements.define("elapsed-time", ElapsedTime);
