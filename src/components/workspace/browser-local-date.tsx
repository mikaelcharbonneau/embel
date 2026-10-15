"use client";

import { useSyncExternalStore } from "react";
import { formatAccountDate } from "@/domain/account-profile";
import { useAccountProfile } from "./account-profile-provider";

const subscribe = () => () => {};
const serverDate = () => null;

export function formatBrowserDate(dateTime: string, locale?: string) {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(new Date(dateTime));
}

/** Saved account preferences apply after owner verification; browser-only views use the device. */
export function BrowserLocalDate({ dateTime, prefix = "" }: { dateTime: string; prefix?: string }) {
  const profile = useAccountProfile();
  const preferences = profile?.workspace?.saved.values;
  const date = useSyncExternalStore(subscribe, () => preferences ? formatAccountDate(dateTime, preferences) : formatBrowserDate(dateTime), serverDate);
  return <time dateTime={dateTime}>{prefix}{date ?? "…"}</time>;
}
