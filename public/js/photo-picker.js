// <photo-picker action="/settings/photo">: wraps a file input. Picking an image crops it to a centered
// square, shrinks it to 256×256 JPEG in the browser (a phone photo is several MB; this is ~20 KB), posts
// the bytes to `action` and reloads the page to show it. Problems show in the picker's [role=status].
const SIZE = 256;

class PhotoPicker extends HTMLElement {
  connectedCallback() {
    this.querySelector("input[type=file]")?.addEventListener("change", (e) => this.upload(e.target));
  }

  say(message) {
    const status = this.querySelector("[role=status]");
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
  }

  async upload(input) {
    const file = input.files?.[0];
    input.value = ""; // picking the same file again should try again
    if (!file) return;
    this.say("Saving…");
    let blob;
    try {
      blob = await shrink(file);
    } catch {
      return this.say("Couldn't read that image. Try a JPEG or PNG.");
    }
    const res = await fetch(this.getAttribute("action"), { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob })
      .catch(() => null);
    if (res?.ok) return location.assign("/settings?saved=photo");
    const text = res?.headers.get("Content-Type")?.startsWith("text/plain") ? await res.text() : "";
    this.say(text || "Couldn't save that photo. Try again.");
  }
}

async function shrink(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // a transparent PNG would otherwise turn black as a JPEG
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.85));
}

customElements.define("photo-picker", PhotoPicker);
