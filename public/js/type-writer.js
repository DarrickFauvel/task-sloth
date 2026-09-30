// <type-writer>text</type-writer>: types its text out softly, one character at a time (each fades and
// un-blurs in), with a caret that blinks while typing and fades away after (.is-done). The server renders
// the full text, so without script, or with reduced motion, it just shows. Screen readers get the text
// once, whole: the animated letters are aria-hidden.
const STEP_MS = 45;

class TypeWriter extends HTMLElement {
  connectedCallback() {
    if (this.dataset.typed || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    this.dataset.typed = "true";
    const text = this.textContent.trim();
    const whole = Object.assign(document.createElement("span"), { className: "visually-hidden", textContent: text });
    const shown = document.createElement("span");
    shown.setAttribute("aria-hidden", "true");
    const caret = Object.assign(document.createElement("span"), { className: "tw-caret" });
    shown.append(caret);
    // Letters go in one by one, just ahead of the caret, so it always sits after the last one typed.
    const chars = [...text];
    let i = 0;
    const typeNext = () => {
      if (i === chars.length) return caret.classList.add("is-done");
      caret.before(Object.assign(document.createElement("span"), { className: "tw-char", textContent: chars[i++] }));
      // A little jitter so it feels typed, not ticked out by a metronome.
      setTimeout(typeNext, STEP_MS + Math.random() * 30);
    };
    setTimeout(typeNext, 250);
    this.replaceChildren(whole, shown);
  }
}

customElements.define("type-writer", TypeWriter);
