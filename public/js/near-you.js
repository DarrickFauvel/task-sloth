// "Near you" on the home page: while the app is open, this device's position is checked against the household's
// spots (where/hows on the map, sent as #task-list's data-near-you; a shop can have several), all in the browser. Near one with
// something to do there, it shows a banner linking to those tasks, moves that place's group to the top of a list
// grouped by Where / how, and, if the page isn't on screen and notifications are allowed, sends a notification.
// It's off until someone turns it on for this device on the Where / how page (near-you-switch.js).

import { nearestPlace } from "./lib/places.js";

const KEY = "near-you";

/** Whether Near you is on for this device. Storage can be missing (a private window), so that reads as off. */
export function nearYouOn() {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function setNearYou(on) {
  try {
    if (on) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {
    // Not saved; it stays off.
  }
}

class NearYou extends HTMLElement {
  connectedCallback() {
    this.list = document.getElementById("task-list");
    if (!this.list || !nearYouOn() || !("geolocation" in navigator)) return;
    this.place = null; // the spot we're near, from the last reading
    this.dismissed = null; // a where/how whose banner was closed; it stays closed until we leave it
    this.position = null;
    // Live updates replace the list (new counts, places, groups): read the places again and re-apply.
    this.observer = new MutationObserver(() => this.update());
    this.observer.observe(this.list, { attributes: true, attributeFilter: ["data-near-you"], childList: true });
    this.watch = navigator.geolocation.watchPosition(
      (p) => {
        this.position = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
        this.update();
      },
      // Permission taken back, or no fix: show nothing. The Where / how page explains how to turn it on again.
      () => {},
      { enableHighAccuracy: true, maximumAge: 30_000 },
    );
  }

  disconnectedCallback() {
    this.observer?.disconnect();
    if (this.watch != null) navigator.geolocation.clearWatch(this.watch);
  }

  places() {
    try {
      return JSON.parse(this.list.dataset.nearYou ?? "[]");
    } catch {
      return [];
    }
  }

  update() {
    const places = this.places();
    // Spots decide when we arrive and leave; the where/how decides what's said, so walking between two branches
    // of the same shop doesn't notify again.
    const wasContext = this.place?.contextId ?? null;
    this.place = this.position ? nearestPlace(this.position, places, this.place?.id ?? null) : null;
    if (this.place?.contextId !== wasContext) {
      if (this.dismissed && this.dismissed !== this.place?.contextId) this.dismissed = null;
      if (this.place) this.notify(this.place);
    }
    this.render();
    this.raiseGroup();
  }

  render() {
    const p = this.place;
    if (!p || this.dismissed === p.contextId) {
      this.shown = null;
      return this.replaceChildren();
    }
    // Only redraw when something changed, so a reading every few seconds doesn't make it flicker.
    const key = `${p.contextId}:${p.count}:${p.name}`;
    if (this.shown === key) return;
    this.shown = key;
    const things = p.count === 1 ? "1 thing to do" : `${p.count} things to do`;
    // Built with textContent, since place names are typed by people.
    const box = document.createElement("aside");
    box.className = "panel near-banner";
    box.setAttribute("aria-label", "Near you");
    const text = document.createElement("p");
    text.append("📍 You're near ");
    const name = document.createElement("strong");
    name.textContent = p.name;
    text.append(name, `: ${things} there.`);
    const actions = document.createElement("div");
    actions.className = "actions";
    const link = document.createElement("a");
    link.className = "button";
    link.href = p.href;
    link.textContent = "Show them";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "link";
    close.textContent = "Not now";
    close.addEventListener("click", () => {
      this.dismissed = p.contextId;
      this.render();
    });
    actions.append(link, close);
    box.append(text, actions);
    this.replaceChildren(box);
  }

  /**
   * Grouped by Where / how: the place we're near goes first, after only "Working on now" (what people are doing
   * right now stays on top). The server's order comes back with each update.
   */
  raiseGroup() {
    const p = this.place;
    if (!p) return;
    const group = this.list.querySelector(`.task-group[data-context="${CSS.escape(p.contextId)}"]`);
    const first = this.list.querySelector(".task-group:not(.is-working-group)");
    if (group && first && group !== first) first.before(group);
  }

  /** A notification when we arrive somewhere, only if the page isn't being looked at (then the banner does it). */
  notify(p) {
    if (document.visibilityState === "visible" || !("Notification" in window) || Notification.permission !== "granted") return;
    const body = p.count === 1 ? "1 thing to do there" : `${p.count} things to do there`;
    navigator.serviceWorker?.ready
      .then((reg) => reg.showNotification(`You're near ${p.name}`, { body, tag: `near-${p.contextId}`, icon: "/img/icon-192.png", data: { url: p.href } }))
      .catch(() => {});
  }
}

customElements.define("near-you", NearYou);
