import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ client: vi.fn(), user: vi.fn(), from: vi.fn() }));
vi.mock("@/server/auth/client", () => ({ createRouteAuthClient: mocks.client }));
import {
  getProfileContext,
  readAccountProfile,
  saveAccountProfile,
  type ProfileContext,
} from "@/server/data/account-profile";
import { DEFAULT_PROFILE_VALUES } from "@/domain/account-profile";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const row = {
  owner_id: owner,
  full_name: "Saved",
  time_zone: "America/Toronto",
  date_format: "friendly",
  revision: 1,
  updated_at: "2026-10-13T00:00:00Z",
};
let auth: ProfileContext;
function reply(data: unknown, error: { code: string } | null = null) {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
  for (const key of ["select", "eq", "insert", "update"] as const) builder[key].mockReturnValue(builder);
  mocks.from.mockReturnValue(builder);
  return builder;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.client.mockResolvedValue({ auth: { getUser: mocks.user }, from: mocks.from });
  mocks.user.mockResolvedValue({
    data: {
      user: {
        id: owner,
        email: "verified@example.invalid",
        email_confirmed_at: "2026-10-13T10:00:00Z",
        user_metadata: { email: "forged@example.invalid", owner_id: "forged", role: "admin" },
      },
    },
    error: null,
  });
  auth = {
    client: { from: mocks.from } as unknown as ProfileContext["client"],
    userId: owner,
    email: "verified@example.invalid",
  };
});
describe("verified account profile data", () => {
  it("takes read-only email and owner from Auth.getUser, ignoring editable metadata", async () => {
    expect(await getProfileContext()).toMatchObject({ userId: owner, email: "verified@example.invalid" });
    expect(mocks.user).toHaveBeenCalledOnce();
    mocks.user.mockResolvedValue({ data: { user: { id: owner, is_anonymous: true } }, error: null });
    await expect(getProfileContext()).rejects.toMatchObject({ code: "unauthenticated" });
    mocks.user.mockRejectedValue(new Error("internal private detail"));
    await expect(getProfileContext()).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it("uses the confirmed-account policy and forwards request cancellation", async () => {
    const signal = new AbortController().signal;
    expect(await getProfileContext(signal)).toMatchObject({ userId: owner, email: "verified@example.invalid" });
    expect(mocks.client).toHaveBeenCalledWith(signal);
    mocks.user.mockResolvedValue({
      data: { user: { id: owner, is_anonymous: false, email_confirmed_at: null } },
      error: null,
    });
    await expect(getProfileContext(signal)).rejects.toMatchObject({ code: "unauthenticated" });
    for (const error of [{ status: 429 }, { status: 503 }, { name: "AuthRetryableFetchError" }]) {
      mocks.user.mockResolvedValue({ data: { user: null }, error });
      await expect(getProfileContext(signal)).rejects.toMatchObject({ code: "integration_unavailable" });
    }
  });
  it("returns unsaved defaults for an existing account without creating profile or project data", async () => {
    const query = reply(null);
    expect(await readAccountProfile(auth)).toEqual({
      ownerId: owner,
      email: auth.email,
      values: DEFAULT_PROFILE_VALUES,
      revision: 0,
      updatedAt: null,
    });
    expect(query.eq).toHaveBeenCalledWith("owner_id", owner);
    expect(query.insert).not.toHaveBeenCalled();
    expect(query.update).not.toHaveBeenCalled();
  });
  it("restores saved values and rejects foreign or malformed rows", async () => {
    reply(row);
    expect(await readAccountProfile(auth)).toMatchObject({
      revision: 1,
      values: { fullName: "Saved" },
      email: auth.email,
    });
    reply({ ...row, owner_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    await expect(readAccountProfile(auth)).rejects.toMatchObject({ code: "integration_unavailable" });
    reply({ ...row, time_zone: "bad" });
    await expect(readAccountProfile(auth)).rejects.toMatchObject({ code: "integration_unavailable" });
  });
  it("derives insert ownership and uses a version predicate for updates", async () => {
    const insert = reply(row);
    await saveAccountProfile(auth, { expectedRevision: 0, values: { ...DEFAULT_PROFILE_VALUES, fullName: "Saved" } });
    expect(insert.insert).toHaveBeenCalledWith({
      owner_id: owner,
      full_name: "Saved",
      time_zone: "America/Toronto",
      date_format: "friendly",
    });
    const update = reply({ ...row, revision: 2 });
    await saveAccountProfile(auth, { expectedRevision: 1, values: { ...DEFAULT_PROFILE_VALUES, fullName: "Saved" } });
    expect(update.eq.mock.calls).toEqual([
      ["owner_id", owner],
      ["revision", 1],
    ]);
    expect(update.update).toHaveBeenCalledWith({
      full_name: "Saved",
      time_zone: "America/Toronto",
      date_format: "friendly",
    });
  });
  it("reports stale versions and competing first saves as conflicts without exposing database errors", async () => {
    reply(null);
    await expect(
      saveAccountProfile(auth, { expectedRevision: 1, values: DEFAULT_PROFILE_VALUES }),
    ).rejects.toMatchObject({ code: "conflict" });
    reply(null, { code: "23505" });
    await expect(
      saveAccountProfile(auth, { expectedRevision: 0, values: DEFAULT_PROFILE_VALUES }),
    ).rejects.toMatchObject({ code: "conflict" });
    reply(null, { code: "42P01" });
    await expect(readAccountProfile(auth)).rejects.toMatchObject({ code: "integration_unavailable" });
  });
});
