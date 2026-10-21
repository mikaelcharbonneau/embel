/** jsdom does not implement native modal methods. No production fallback. */
export function installDialogMethods() {
  const keys = ["showModal", "close"] as const;
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, key));
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; this.querySelector<HTMLElement>("button,input,textarea,select")?.focus(); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
  return () => keys.forEach((key, index) => { const original = originals[index]; if (original) Object.defineProperty(HTMLDialogElement.prototype, key, original); else Reflect.deleteProperty(HTMLDialogElement.prototype, key); });
}
