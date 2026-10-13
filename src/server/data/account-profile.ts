import "server-only";
import { z } from "zod";
import { accountProfileSchema, accountProfileValuesSchema, DEFAULT_PROFILE_VALUES, type SaveAccountProfile } from "@/domain/account-profile";
import { createRouteAuthClient } from "../auth/client";
import { ApiError } from "../http/errors";

/** A fresh Auth server check supplies both the owner and read-only account email. */
export async function getProfileContext(signal?: AbortSignal) {
  const client = await createRouteAuthClient(signal);
  const { data, error } = await client.auth.getUser().catch(() => { throw new ApiError("integration_unavailable"); });
  if (error && (error.name === "AuthRetryableFetchError" || error.status === 429 || (error.status ?? 0) >= 500)) throw new ApiError("integration_unavailable");
  if (error || !data.user || data.user.is_anonymous) throw new ApiError("unauthenticated");
  return { client, userId: data.user.id, email: data.user.email ?? null };
}
export type ProfileContext = Awaited<ReturnType<typeof getProfileContext>>;
const columns = "owner_id,full_name,time_zone,date_format,revision,updated_at";
const rowSchema = z.strictObject({
  owner_id: z.uuid(), full_name: z.string(), time_zone: z.string(), date_format: z.string(),
  revision: z.number().int().positive(), updated_at: z.iso.datetime({ offset: true }),
});

function profileFromRow(auth: ProfileContext, data: unknown) {
  const parsed = rowSchema.safeParse(data);
  if (!parsed.success || parsed.data.owner_id !== auth.userId) throw new ApiError("integration_unavailable");
  const row = parsed.data;
  const profile = accountProfileSchema.safeParse({ ownerId: row.owner_id, email: auth.email, revision: row.revision,
    updatedAt: row.updated_at, values: { fullName: row.full_name, timeZone: row.time_zone, dateFormat: row.date_format } });
  if (!profile.success) throw new ApiError("integration_unavailable");
  return profile.data;
}

export async function readAccountProfile(auth: ProfileContext) {
  const { data, error } = await auth.client.from("account_profiles").select(columns).eq("owner_id", auth.userId).maybeSingle();
  if (error) throw new ApiError("integration_unavailable");
  // No auth trigger or mandatory bootstrap: older accounts and new signups work immediately.
  return data === null ? accountProfileSchema.parse({ ownerId: auth.userId, email: auth.email, revision: 0, updatedAt: null, values: DEFAULT_PROFILE_VALUES }) : profileFromRow(auth, data);
}

export async function saveAccountProfile(auth: ProfileContext, input: SaveAccountProfile) {
  const values = accountProfileValuesSchema.parse(input.values);
  const fields = { full_name: values.fullName, time_zone: values.timeZone, date_format: values.dateFormat };
  const mutation = input.expectedRevision === 0
    ? auth.client.from("account_profiles").insert({ owner_id: auth.userId, ...fields })
    : auth.client.from("account_profiles").update(fields).eq("owner_id", auth.userId).eq("revision", input.expectedRevision);
  const { data, error } = await mutation.select(columns).maybeSingle();
  if (error) throw new ApiError(error.code === "23505" ? "conflict" : "integration_unavailable");
  if (data === null) throw new ApiError("conflict");
  const profile = profileFromRow(auth, data);
  if (profile.revision !== input.expectedRevision + 1) throw new ApiError("integration_unavailable");
  return profile;
}
