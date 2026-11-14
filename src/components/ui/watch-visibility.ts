/**
 * Calls `show` once, the first time `element` is within `margin` CSS pixels of the viewport, then stops watching.
 *
 * An IntersectionObserver does the work. Its notifications are delivered only while the browser produces frames,
 * so a page that renders slowly or not at all (a background tab or a hidden pane) can hold them back indefinitely.
 * A shared sweep therefore also measures every pending element once a second, and when the page becomes visible
 * or focused again, so an element already on screen never waits for a notification that does not come. An element
 * that is not rendered (`hidden`, or inside a hidden parent) is never treated as visible.
 *
 * Returns a function that stops watching. Without IntersectionObserver it does nothing, and `show` is never called.
 */
export function watchVisibility(element: Element, show: () => void, margin = 0): () => void {
  if (typeof IntersectionObserver === "undefined") return () => undefined;
  let watching = true;
  const watch: Watch = {
    element,
    margin,
    show() {
      if (!watching) return;
      stop();
      show();
    },
  };
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) watch.show();
    },
    { rootMargin: `${margin}px` },
  );
  function stop() {
    if (!watching) return;
    watching = false;
    observer.disconnect();
    watched.delete(watch);
    if (!watched.size) stopSweeping();
  }
  observer.observe(element);
  watched.add(watch);
  startSweeping();
  return stop;
}

type Watch = { element: Element; margin: number; show(): void };
const watched = new Set<Watch>();
let sweeper: ReturnType<typeof setInterval> | null = null;

/** Whether the element is rendered and within `margin` of the viewport. Reading its box is reliable even when the
 * page is not painting. */
export function isNearViewport(element: Element, margin = 0) {
  if (!element.isConnected || !element.getClientRects().length) return false;
  const box = element.getBoundingClientRect();
  const width = window.innerWidth || document.documentElement.clientWidth;
  const height = window.innerHeight || document.documentElement.clientHeight;
  return box.bottom >= -margin && box.right >= -margin && box.top <= height + margin && box.left <= width + margin;
}

function sweep() {
  for (const watch of [...watched]) if (isNearViewport(watch.element, watch.margin)) watch.show();
}
function onVisibility() {
  if (document.visibilityState === "visible") sweep();
}
function startSweeping() {
  if (sweeper) return;
  sweeper = setInterval(sweep, 1_000);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", sweep);
  window.addEventListener("pageshow", sweep);
}
function stopSweeping() {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("focus", sweep);
  window.removeEventListener("pageshow", sweep);
}
