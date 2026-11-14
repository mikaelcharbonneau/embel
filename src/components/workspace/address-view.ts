"use client";

/** On-screen choices kept in the page address (D-097), so a reload, Back or a
 * shared link keeps them. Read only by lists that render after the account
 * check, which happens in the browser, so the server never renders them. */
export function readViewFromAddress(): URLSearchParams {
  return new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
}

/** Writes the given choices into the address without navigating; an empty or
 * default value (passed as null) is left out so plain addresses stay plain. */
export function writeViewToAddress(values: Record<string, string | null | undefined>) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  // Replace, not push: changing a filter is not a new page to go Back to.
  if (url.href !== window.location.href) window.history.replaceState(null, "", url);
}
