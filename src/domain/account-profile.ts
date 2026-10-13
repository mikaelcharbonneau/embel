import { z } from "zod";

export const PROFILE_MAX_BYTES = 2048;
export const PROFILE_TIME_ZONES = [
  "America/Toronto", "America/Vancouver", "America/New_York", "America/Chicago",
  "America/Denver", "America/Los_Angeles", "America/Sao_Paulo", "Europe/London",
  "Europe/Paris", "Europe/Berlin", "Africa/Johannesburg", "Asia/Dubai", "Asia/Kolkata",
  "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland", "UTC",
] as const;

export const accountProfileValuesSchema = z.strictObject({
  fullName: z.string().trim().max(100).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value), "Use a name without control characters."),
  timeZone: z.enum(PROFILE_TIME_ZONES),
  dateFormat: z.enum(["friendly", "iso"]),
});
export type AccountProfileValues = z.infer<typeof accountProfileValuesSchema>;
export const DEFAULT_PROFILE_VALUES: AccountProfileValues = { fullName: "", timeZone: "America/Toronto", dateFormat: "friendly" };

export const accountProfileSchema = z.strictObject({
  ownerId: z.uuid(),
  // Auth.getUser supplies this display-only identity field, never a profile row.
  email: z.string().max(320).nullable(),
  revision: z.number().int().min(0).max(2_147_483_646),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
  values: accountProfileValuesSchema,
}).refine(profile => profile.revision === 0 ? profile.updatedAt === null : profile.updatedAt !== null);
export type AccountProfile = z.infer<typeof accountProfileSchema>;
export const accountProfileReplySchema = z.strictObject({ profile: accountProfileSchema });
export const saveAccountProfileSchema = z.strictObject({
  expectedRevision: z.number().int().min(0).max(2_147_483_645),
  values: accountProfileValuesSchema,
});
export type SaveAccountProfile = z.infer<typeof saveAccountProfileSchema>;

export function sameProfileValues(left: AccountProfileValues, right: AccountProfileValues) {
  return left.fullName === right.fullName && left.timeZone === right.timeZone && left.dateFormat === right.dateFormat;
}

export function formatAccountDate(dateTime: string, preferences: Pick<AccountProfileValues, "timeZone" | "dateFormat">, locale = "en-CA") {
  const date = new Date(dateTime);
  if (preferences.dateFormat === "iso") {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: preferences.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }
  return new Intl.DateTimeFormat(locale, { timeZone: preferences.timeZone, year: "numeric", month: "short", day: "numeric" }).format(date);
}
