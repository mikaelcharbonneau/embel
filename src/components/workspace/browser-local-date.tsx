"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const serverDate = () => null;

export function formatBrowserDate(dateTime: string, locale?: string) {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(new Date(dateTime));
}

/** The first server/client render agrees; the browser supplies its own locale and zone. */
export function BrowserLocalDate({ dateTime, prefix = "" }: { dateTime: string; prefix?: string }) {
  const date = useSyncExternalStore(subscribe, () => formatBrowserDate(dateTime), serverDate);
  return <time dateTime={dateTime}>{prefix}{date ?? "…"}</time>;
}
