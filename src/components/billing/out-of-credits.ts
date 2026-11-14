/** Every refused start for lack of credits (HTTP 402 from a generation route) is announced
 * once, so one prompt for the whole app can offer the Plans page wherever it happened.
 * A step that shows the out-of-credits message in place (at the control that was pressed)
 * runs its start through `runWithCreditsInPlace`; the app-wide prompt then stays closed, so
 * the step's message is the only one about credits on the screen. */
export const OUT_OF_CREDITS_EVENT = "embel:out-of-credits";

let inPlace = 0;

export function announceOutOfCredits() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OUT_OF_CREDITS_EVENT, { detail: { inPlace: inPlace > 0 } }));
}

/** The app-wide prompt: told only about refusals no step shows in place. */
export function onOutOfCredits(listener: () => void) {
  const handle = (event: Event) => {
    if (!(event instanceof CustomEvent && event.detail?.inPlace)) listener();
  };
  window.addEventListener(OUT_OF_CREDITS_EVENT, handle);
  return () => window.removeEventListener(OUT_OF_CREDITS_EVENT, handle);
}

/** Runs a start whose refusal for lack of credits the caller shows in place, and says whether it was refused so. */
export async function runWithCreditsInPlace<T>(work: () => Promise<T>): Promise<{ result: T; outOfCredits: boolean }> {
  let outOfCredits = false;
  const handle = () => {
    outOfCredits = true;
  };
  window.addEventListener(OUT_OF_CREDITS_EVENT, handle);
  inPlace++;
  try {
    return { result: await work(), outOfCredits };
  } finally {
    inPlace--;
    window.removeEventListener(OUT_OF_CREDITS_EVENT, handle);
  }
}
