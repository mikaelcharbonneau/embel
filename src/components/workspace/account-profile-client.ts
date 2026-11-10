import { accountProfileReplySchema, saveAccountProfileSchema, type SaveAccountProfile } from "@/domain/account-profile";
import { boundedAccountRequest } from "./bounded-account-request";
import type { VerifiedAccount } from "./account-session";

export async function loadProfile(signal: AbortSignal) {
  return (await boundedAccountRequest("/api/account/profile", accountProfileReplySchema, { signal })).profile;
}
export async function saveProfile(account: VerifiedAccount, input: SaveAccountProfile, signal: AbortSignal) {
  return (
    await boundedAccountRequest("/api/account/profile", accountProfileReplySchema, {
      method: "PATCH",
      body: saveAccountProfileSchema.parse(input),
      signal,
      expectedOwnerId: account.userId,
    })
  ).profile;
}
