import { describe, expect, it } from "vitest";
import { createAccountProfileMemory, receiveAccountProfile } from "@/components/workspace/account-profile-memory";
import { DEFAULT_PROFILE_VALUES, type AccountProfile } from "@/domain/account-profile";
const a = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 };
const b = { userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", generation: 2 };
const saved: AccountProfile = {
  ownerId: a.userId,
  email: "a@example.invalid",
  revision: 1,
  updatedAt: "2026-10-13T00:00:00Z",
  values: { ...DEFAULT_PROFILE_VALUES, fullName: "Saved name" },
};
const draft = () => ({ saved, values: { ...saved.values, fullName: "Draft name" }, latest: null, mustReload: false });
describe("owner-scoped profile edit memory", () => {
  it("hides private edits during rechecks, restores only the same owner, and rejects stale generations", () => {
    const memory = createAccountProfileMemory();
    memory.bind(a);
    expect(memory.set(a, draft())).toBe(true);
    expect(memory.hasUnsaved()).toBe(true);
    memory.bind(null);
    expect(memory.get(a)).toBeNull();
    expect(memory.set(a, draft())).toBe(false);
    const next = { ...a, generation: 3 };
    memory.bind(next);
    expect(memory.get(next)?.values.fullName).toBe("Draft name");
    expect(memory.get(a)).toBeNull();
    expect(memory.set(a, draft())).toBe(false);
    memory.bind(b);
    expect(memory.get(b)).toBeNull();
    expect(memory.hasUnsaved()).toBe(false);
    expect(memory.set(b, draft())).toBe(false);
    memory.bind(next);
    expect(memory.get(next)).toBeNull();
  });
  it("retains dirty values and exposes a changed saved revision for an explicit decision", () => {
    const fresh = { ...saved, revision: 2, values: { ...saved.values, fullName: "Other session" } };
    const workspace = receiveAccountProfile(draft(), fresh);
    expect(workspace.values.fullName).toBe("Draft name");
    expect(workspace.saved.revision).toBe(1);
    expect(workspace.latest).toEqual(fresh);
    expect(receiveAccountProfile(draft(), saved).latest).toBeNull();
  });
  it("resolves uncertainty only with a fresh read and clears all retained data on logout", () => {
    const pending = { ...draft(), mustReload: true };
    // An unchanged revision proves the interrupted write did not land: keep the edits for another save.
    expect(receiveAccountProfile(pending, saved)).toEqual({ ...pending, mustReload: false });
    // A moved revision with other values still asks for an explicit choice.
    const other = { ...saved, revision: 2, values: { ...saved.values, fullName: "Other session" } };
    expect(receiveAccountProfile(pending, other).latest).toEqual(other);
    const current = { ...saved, revision: 2, values: pending.values };
    expect(receiveAccountProfile(pending, current)).toEqual({
      saved: current,
      values: current.values,
      latest: null,
      mustReload: false,
    });
    const memory = createAccountProfileMemory();
    memory.bind(a);
    memory.set(a, pending);
    memory.clear();
    memory.bind(a);
    expect(memory.get(a)).toBeNull();
    expect(memory.hasUnsaved()).toBe(false);
  });
});
