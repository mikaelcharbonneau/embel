/** Every refused start for lack of credits (HTTP 402 from a generation route) is announced
 * once, so one prompt for the whole app can offer the Plans page wherever it happened. */
export const OUT_OF_CREDITS_EVENT = "embel:out-of-credits";

export function announceOutOfCredits() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OUT_OF_CREDITS_EVENT));
}

export function onOutOfCredits(listener: () => void) {
  window.addEventListener(OUT_OF_CREDITS_EVENT, listener);
  return () => window.removeEventListener(OUT_OF_CREDITS_EVENT, listener);
}
