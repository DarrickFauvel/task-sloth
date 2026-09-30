// <task-photo action="/tasks/<id>/photos">: wraps file inputs (a camera one and a library one). Each picked
// photo is shrunk in the browser to at most 2000px on its long side as a JPEG (a phone photo is several MB;
// this is a few hundred KB) and posted to `action`, one at a time. The page's live update then shows it.
// Progress and problems show in the element's [role=status].
const MAX_SIDE = 2000;

class TaskPhoto extends HTMLElement {
  connectedCallback() {
    for (const input of this.querySelectorAll("input[type=file]")) input.addEventListener("change", () => this.upload(input));
  }

  say(message) {
    const status = this.querySelector("[role=status]");
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
  }

  async upload(input) {
    const files = [...(input.files ?? [])];
    input.value = ""; // picking the same file again should try again
    if (!files.length || this.busy) return;
    this.busy = true;
    try {
      for (const [i, file] of files.entries()) {
        this.say(files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : "Uploading…");
        const error = await this.send(file);
        if (error) return this.say(error);
      }
      this.say("");
    } finally {
      this.busy = false;
    }
  }

  /** @returns {Promise<string>} an error to show, or "" */
  async send(file) {
    let blob;
    try {
      blob = await shrink(file);
    } catch {
      return "Couldn't read that image. Try a JPEG or PNG.";
    }
    const res = await fetch(this.getAttribute("action"), { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob })
      .catch(() => null);
    if (res?.ok) return "";
    const text = res?.headers.get("Content-Type")?.startsWith("text/plain") ? await res.text() : "";
    return text || "Couldn't save that photo. Try again.";
  }
}

async function shrink(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // a transparent PNG would otherwise turn black as a JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.85));
}

customElements.define("task-photo", TaskPhoto);
