// The Where / how page's script (views/pages/places.eta):
// - <near-you-switch> turns "Near you" on or off for this device, asking for location (and notifications) first;
// - <here-button> fills a form with this device's position and posts it ("I'm here now");
// - when this browser already shares its location, address searches send it, so nearby results come first.

import { nearYouOn, setNearYou } from "./near-you.js";

/** This device's position, or a plain-language reason it isn't available. */
const locate = (options = {}) =>
  new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("This browser can't share its location."));
    navigator.geolocation.getCurrentPosition(resolve, (err) => reject(new Error(
      err.code === err.PERMISSION_DENIED
        ? "Location is blocked for this site. Allow it in your browser's site settings, then try again."
        : "Couldn't find where you are. Try again in a moment, or outside.",
    )), { enableHighAccuracy: true, timeout: 20_000, maximumAge: 60_000, ...options });
  });

class NearYouSwitch extends HTMLElement {
  connectedCallback() {
    this.querySelector("[data-state=no-script]")?.remove();
    this.status = this.querySelector("[data-status]");
    this.querySelector("[data-action=on]").addEventListener("click", () => this.turnOn());
    this.querySelector("[data-action=off]").addEventListener("click", () => {
      setNearYou(false);
      this.status.textContent = "Turned off for this phone.";
      this.show();
    });
    if (!("geolocation" in navigator)) this.status.textContent = "This browser can't share its location, so Near you can't work here.";
    this.show();
  }

  show() {
    const on = nearYouOn();
    this.querySelector("[data-action=on]").hidden = on || !("geolocation" in navigator);
    this.querySelector("[data-state=on]").hidden = !on;
  }

  async turnOn() {
    this.status.textContent = "Asking your phone where it is…";
    try {
      await locate();
    } catch (err) {
      this.status.textContent = err.message;
      return;
    }
    setNearYou(true);
    // Notifications are a nice extra: ask, but Near you works without them.
    let note = "";
    if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission().catch(() => {});
    if ("Notification" in window && Notification.permission === "denied") note = " Notifications are blocked, so you'll only see it in the app.";
    this.status.textContent = `Turned on.${note}`;
    this.show();
  }
}

// One listener on the element, not the button: saving a place re-renders the list around it.
class HereButton extends HTMLElement {
  connectedCallback() {
    this.addEventListener("click", (evt) => {
      const button = evt.target.closest("button");
      if (button && this.contains(button)) this.useHere(button);
    });
  }

  async useHere(button) {
    const form = this.querySelector("form");
    const status = this.querySelector("[data-status]");
    button.disabled = true;
    status.textContent = "Finding where you are…";
    try {
      // A fresh reading: an old one might be from somewhere else.
      const p = await locate({ maximumAge: 0 });
      form.elements.lat.value = p.coords.latitude;
      form.elements.lng.value = p.coords.longitude;
      status.textContent = "";
      form.requestSubmit();
    } catch (err) {
      status.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  }
}

customElements.define("near-you-switch", NearYouSwitch);
customElements.define("here-button", HereButton);

// Nearby results first, but only without a prompt: the position is used only if this site may already have it,
// and only roughly (to about 10 km).
navigator.permissions?.query({ name: "geolocation" }).then(async (perm) => {
  if (perm.state !== "granted") return;
  const p = await locate({ enableHighAccuracy: false, maximumAge: 10 * 60_000 }).catch(() => null);
  if (!p) return;
  // The search forms are in the sheets, which are never re-rendered, so once is enough.
  document.querySelectorAll(".place-search").forEach((f) => {
    f.elements.nearLat.value = p.coords.latitude.toFixed(1);
    f.elements.nearLng.value = p.coords.longitude.toFixed(1);
  });
}).catch(() => {});
