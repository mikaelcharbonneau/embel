import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  assertConfirmationEmail, assertFreshSignIn, deleteSignedInAccount, FRESH_SIGN_IN_SECONDS, runAccountDeletion,
  sessionSignedInAt, type AccountDeletionStore, type DeletionContext,
} from "@/server/account/deletion";
import { ApiError } from "@/server/http/errors";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const now = 1_800_000_000;

/** An in-memory account: rows, files and an Auth user, with injectable failures. */
function memoryStore(files: string[], failures: Partial<Record<keyof AccountDeletionStore, number>> = {}) {
  const state = { rows: 12, files: [...files], authUser: true, receipt: "none" as "none" | "started" | "data_deleted" | "completed", calls: [] as string[], removedRecorded: 0 };
  const fail = (step: keyof AccountDeletionStore) => {
    if ((failures[step] ?? 0) > 0) { failures[step]! -= 1; throw new Error(`${step} failed`); }
  };
  const store: AccountDeletionStore = {
    async begin() { state.calls.push("begin"); fail("begin"); if (state.receipt === "none") state.receipt = "started"; },
    async purge() { state.calls.push("purge"); fail("purge"); const n = state.rows; state.rows = 0; state.receipt = "data_deleted"; return n; },
    async listFiles(owner) { state.calls.push("list"); fail("listFiles"); return state.files.filter(name => name.startsWith(`${owner}/`)).slice(0, 500); },
    async removeFiles(paths) { state.calls.push("remove"); fail("removeFiles"); const before = state.files.length; state.files = state.files.filter(name => !paths.includes(name)); return before - state.files.length; },
    async recordFilesRemoved(_owner, count) { state.removedRecorded += count; },
    async deleteAuthUser() { state.calls.push("auth"); fail("deleteAuthUser"); state.authUser = false; },
    async complete() { state.calls.push("complete"); fail("complete"); if (state.authUser) throw new Error("account_still_exists"); state.receipt = "completed"; },
  };
  return { store, state };
}
const filesOf = (count: number) => Array.from({ length: count }, (_, index) => `${A}/project/asset/${String(index).padStart(5, "0")}`);

describe("deletion steps", () => {
  it("deletes rows, then every file, then the Auth user, then closes the receipt", async () => {
    const { store, state } = memoryStore(filesOf(730));
    expect(await runAccountDeletion(A, store)).toEqual({ deletedRows: 12, deletedFiles: 730 });
    expect(state).toMatchObject({ rows: 0, files: [], authUser: false, receipt: "completed", removedRecorded: 730 });
    expect(state.calls.indexOf("purge")).toBeLessThan(state.calls.indexOf("remove"));
    expect(state.calls.lastIndexOf("remove")).toBeLessThan(state.calls.indexOf("auth"));
    expect(state.calls.at(-1)).toBe("complete");
  });

  it.each(["purge", "removeFiles", "deleteAuthUser", "complete"] as const)("can be repeated after an interruption at %s and finishes the same deletion", async step => {
    const { store, state } = memoryStore(filesOf(120), { [step]: 1 });
    await expect(runAccountDeletion(A, store)).rejects.toThrow(`${step} failed`);
    expect(state.receipt).not.toBe("completed");
    await runAccountDeletion(A, store);
    expect(state).toMatchObject({ rows: 0, files: [], authUser: false, receipt: "completed" });
  });

  it("refuses a file outside the account's prefix and a Storage that removes nothing", async () => {
    const outside = memoryStore([]);
    outside.store.listFiles = async () => [`bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/x/y/z`];
    await expect(runAccountDeletion(A, outside.store)).rejects.toThrow("account_file_outside_prefix");
    expect(outside.state.authUser).toBe(true);
    const stuck = memoryStore(filesOf(3));
    stuck.store.removeFiles = async () => 0;
    await expect(runAccountDeletion(A, stuck.store)).rejects.toThrow("account_files_not_removed");
    expect(stuck.state.authUser).toBe(true);
  });

  it("rejects a malformed owner before any step", async () => {
    const { store, state } = memoryStore([]);
    await expect(runAccountDeletion("not-a-uuid", store)).rejects.toMatchObject({ code: "invalid_input" });
    expect(state.calls).toEqual([]);
  });
});

describe("confirmation and fresh sign-in", () => {
  it("matches the typed email case-insensitively and nothing else", () => {
    expect(() => assertConfirmationEmail({ email: "Owner@Example.invalid" }, "  owner@example.INVALID ")).not.toThrow();
    for (const typed of ["other@example.invalid", "owner@example", ""]) {
      expect(() => assertConfirmationEmail({ email: "owner@example.invalid" }, typed)).toThrow(ApiError);
    }
    expect(() => assertConfirmationEmail({ email: undefined }, "owner@example.invalid")).toThrow(ApiError);
  });

  it("uses the session's newest sign-in time and requires it within 15 minutes", () => {
    const claims = (ago: number) => ({ amr: [{ method: "password", timestamp: now - 7200 }, { method: "otp", timestamp: now - ago }] });
    expect(sessionSignedInAt(claims(60))).toBe(now - 60);
    expect(() => assertFreshSignIn(claims(60), now)).not.toThrow();
    expect(() => assertFreshSignIn(claims(FRESH_SIGN_IN_SECONDS + 1), now)).toThrow(expect.objectContaining({ code: "reauthentication_required" }));
    for (const stale of [{}, { amr: ["password"] }, { amr: "password" }, null, { amr: [{ method: "password", timestamp: now + 3600 }] }]) {
      expect(() => assertFreshSignIn(stale, now)).toThrow(expect.objectContaining({ code: "reauthentication_required" }));
    }
  });
});

describe("the signed-in deletion", () => {
  function fakeAdmin(files: string[]) {
    const calls: string[] = [];
    let rows = 5, authUser = true;
    const admin = {
      rpc: vi.fn(async (name: string, args: { p_owner: string }) => {
        calls.push(`${name}:${args.p_owner}`);
        if (name === "account_deletion_purge") { const n = rows; rows = 0; return { data: { deletedRows: n }, error: null }; }
        if (name === "account_storage_objects") return { data: files.slice(0, 500), error: null };
        if (name === "account_deletion_complete" && authUser) return { data: null, error: { code: "55000", message: "account_still_exists" } };
        return { data: {}, error: null };
      }),
      storage: { from: () => ({ remove: vi.fn(async (paths: string[]) => { const removed = paths.filter(path => files.includes(path)); files.splice(0, files.length, ...files.filter(path => !paths.includes(path))); return { data: removed.map(name => ({ name })), error: null }; }) }) },
      auth: { admin: { deleteUser: vi.fn(async (id: string) => { calls.push(`deleteUser:${id}`); authUser = false; return { data: {}, error: null }; }) } },
    };
    return { admin, calls };
  }
  function contextFor(signedInAgo: number) {
    const runs = [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }];
    const client = {
      from: () => ({ select: () => ({ eq: () => ({ in: () => ({ limit: async () => ({ data: runs, error: null }) }) }) }) }),
      rpc: vi.fn(async () => ({ data: {}, error: null })),
      auth: { signOut: vi.fn(async () => ({ error: null })) },
    };
    return { client, user: { id: A, email: "owner@example.invalid" }, claims: { sub: A, amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) - signedInAgo }] } };
  }

  it("stops the person's runs with their own login, deletes only their account, and clears the session", async () => {
    const context = contextFor(30);
    const { admin, calls } = fakeAdmin(filesOf(3));
    await deleteSignedInAccount(context as unknown as DeletionContext, "owner@example.invalid", admin as never);
    expect(context.client.rpc).toHaveBeenCalledWith("cancel_generation", { p_run_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    expect(calls.every(call => call.endsWith(A))).toBe(true);
    expect(calls).toContain(`deleteUser:${A}`);
    expect(context.client.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("does nothing for a wrong email or an old sign-in", async () => {
    for (const [context, email, code] of [[contextFor(30), "someone@example.invalid", "confirmation_mismatch"], [contextFor(FRESH_SIGN_IN_SECONDS + 60), "owner@example.invalid", "reauthentication_required"]] as const) {
      const { admin, calls } = fakeAdmin(filesOf(3));
      await expect(deleteSignedInAccount(context as unknown as DeletionContext, email, admin as never)).rejects.toMatchObject({ code });
      expect(calls).toEqual([]);
      expect(context.client.rpc).not.toHaveBeenCalled();
    }
  });

  it("reports an unfinished deletion as such, without the underlying detail", async () => {
    const context = contextFor(30);
    const { admin } = fakeAdmin(filesOf(3));
    admin.auth.admin.deleteUser.mockResolvedValueOnce({ data: null, error: { status: 500, code: "PRIVATE" } } as never);
    await expect(deleteSignedInAccount(context as unknown as DeletionContext, "owner@example.invalid", admin as never)).rejects.toMatchObject({ code: "deletion_incomplete" });
    expect(context.client.auth.signOut).not.toHaveBeenCalled();
  });
});
