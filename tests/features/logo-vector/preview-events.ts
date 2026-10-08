const loaded = new WeakSet<Element>();

/** jsdom has no image decoder. Happy-path fixtures explicitly deliver native
 * load events once for each current comparison element. Failure/readiness
 * regressions use their own event schedule and do not call this helper. */
export function dispatchLogoComparisonLoads(host: Element) {
  for (const image of host.querySelectorAll('img[alt="Original concept"], svg[aria-label="Vector candidate"] > image')) {
    if (!loaded.has(image)) { loaded.add(image); image.dispatchEvent(new Event("load")); }
  }
}
