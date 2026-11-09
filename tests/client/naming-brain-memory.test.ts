import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { initialNamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import { contextSnapshotSchema } from "@/domain/projects";
import type { NamingPreferenceRevision } from "@/domain/project-naming";
import { AccountRequestError } from "@/components/workspace/account-api";

const owner = "a0000000-0000-4000-8000-000000000001", projectId = "b0000000-0000-4000-8000-000000000001";
const account = { userId: owner, generation: 1 };
const context = contextSnapshotSchema.parse({ description: "A synthetic coffee project" });
const initial = initialNamingPreferencesV2(context);
const saved = (version: number, preferences = initial): NamingPreferenceRevision => ({ ownerId: owner, projectId, version, preferences, createdAt: "2026-10-16T10:00:00Z" });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture() {
  const bodies: { expectedPreferencesVersion: number; preferences: typeof initial }[] = [];
  let respond = async (body: typeof bodies[number]) => ({ preferences: saved(body.expectedPreferencesVersion + 1, body.preferences), session: { ownerId: owner, projectId } });
  const request = vi.fn(async (_path: string, _schema: unknown, options: { body?: unknown }) => { const body = options.body as typeof bodies[number]; bodies.push(body); return respond(body); });
  const memory = createNamingBrainMemory({ request: request as never, storage: () => null, debounceMs: 20 });
  memory.bind(account); memory.connectPreferences(account, projectId, saved(1), context);
  return { memory, bodies, respond: (next: typeof respond) => { respond = next; } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("Naming preference acknowledgement", () => {
  it("keeps typing enabled and serializes the newest edit after acknowledgement", async () => {
    const { memory, bodies, respond } = fixture(), first = deferred<Awaited<ReturnType<Parameters<typeof respond>[0]>>>();
    respond(body => bodies.length === 1 ? first.promise : Promise.resolve({ preferences: saved(body.expectedPreferencesVersion + 1, body.preferences), session: { ownerId: owner, projectId } }));
    memory.editPreferences(account, projectId, { ...initial, notes: "First" });
    await vi.advanceTimersByTimeAsync(20);
    memory.editPreferences(account, projectId, { ...initial, notes: "Newest" });
    await vi.advanceTimersByTimeAsync(100);
    expect(bodies).toHaveLength(1); expect(memory.get(account, projectId)?.preferences?.draft.notes).toBe("Newest");
    first.resolve({ preferences: saved(2, bodies[0]!.preferences), session: { ownerId: owner, projectId } });
    await vi.advanceTimersByTimeAsync(21);
    expect(bodies.map(body => [body.expectedPreferencesVersion, body.preferences.notes])).toEqual([[1, "First"], [2, "Newest"]]);
    expect(memory.get(account, projectId)?.preferences?.status).toBe("saved");
  });
  it("retries the exact uncertain save before applying newer edits", async () => {
    const { memory, bodies, respond } = fixture(); respond(async () => { throw new AccountRequestError(503); });
    memory.editPreferences(account, projectId, { ...initial, notes: "Original" }); await vi.advanceTimersByTimeAsync(20);
    memory.editPreferences(account, projectId, { ...initial, notes: "Newer" }); await vi.advanceTimersByTimeAsync(100);
    expect(bodies).toHaveLength(1); expect(memory.get(account, projectId)?.preferences?.status).toBe("error");
    respond(async body => ({ preferences: saved(body.expectedPreferencesVersion + 1, body.preferences), session: { ownerId: owner, projectId } }));
    expect(await memory.flushPreferences(account, projectId, true)).toBe(true);
    expect(bodies.map(body => [body.expectedPreferencesVersion, body.preferences.notes])).toEqual([[1, "Original"], [1, "Original"], [2, "Newer"]]);
  });
  it("preserves a revert made while the previous edit is saving", async () => {
    const { memory, bodies, respond } = fixture(), first = deferred<Awaited<ReturnType<Parameters<typeof respond>[0]>>>();
    respond(body => bodies.length === 1 ? first.promise : Promise.resolve({ preferences: saved(body.expectedPreferencesVersion + 1, body.preferences), session: { ownerId: owner, projectId } }));
    memory.editPreferences(account, projectId, { ...initial, notes: "Changed" }); await vi.advanceTimersByTimeAsync(20);
    memory.editPreferences(account, projectId, initial);
    first.resolve({ preferences: saved(2, bodies[0]!.preferences), session: { ownerId: owner, projectId } }); await vi.advanceTimersByTimeAsync(21);
    expect(bodies.map(body => body.preferences.notes)).toEqual(["Changed", ""]);
  });
  it("retains pending edits through same-owner verification and rejects late old-owner writes", async () => {
    const { memory, respond } = fixture(), late = deferred<Awaited<ReturnType<Parameters<typeof respond>[0]>>>(); respond(() => late.promise);
    memory.editPreferences(account, projectId, { ...initial, notes: "Private" }); await vi.advanceTimersByTimeAsync(20);
    memory.bind(null); expect(memory.get(account, projectId)).toBeNull();
    const again = { ...account, generation: 2 }; memory.bind(again);
    expect(memory.get(again, projectId)?.preferences?.draft.notes).toBe("Private"); expect(memory.hasUnsaved()).toBe(true);
    expect(memory.get(again, projectId)?.preferences?.status).toBe("error");
    const other = { userId: "a0000000-0000-4000-8000-000000000002", generation: 3 }; memory.bind(other);
    late.resolve({ preferences: saved(2, { ...initial, notes: "Private" }), session: { ownerId: owner, projectId } }); await vi.advanceTimersByTimeAsync(100);
    expect(memory.get(other, projectId)).toBeNull(); expect(memory.hasUnsaved()).toBe(false);
  });
  it("offers a bounded hard-reload recovery only after confirming the matching owner", async () => {
    const values = new Map<string, string>(); const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
    const request = vi.fn(async () => { throw new AccountRequestError(408); });
    const before = createNamingBrainMemory({ storage, request: request as never, debounceMs: 20 }); before.bind(account); before.connectPreferences(account, projectId, saved(1), context);
    before.editPreferences(account, projectId, { ...initial, notes: "Recovered exact intent" }); await vi.advanceTimersByTimeAsync(20);
    const pending = before.get(account, projectId)?.preferences?.pending;
    const after = createNamingBrainMemory({ storage, request: request as never }); after.bind({ ...account, generation: 2 });
    expect(after.get({ ...account, generation: 2 }, projectId)).toBeNull(); expect(after.getRecovery({ ...account, generation: 2 })).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    after.recover({ ...account, generation: 2 }); expect(after.get({ ...account, generation: 2 }, projectId)?.preferences?.pending).toEqual(pending);
    after.bind({ userId: "a0000000-0000-4000-8000-000000000002", generation: 3 }); expect(after.hasUnsaved()).toBe(false);
  });
  it("only resolves an uncertain save from the exact next version and content", async () => {
    const { memory, respond } = fixture(); respond(async () => { throw new AccountRequestError(408); });
    memory.editPreferences(account, projectId, { ...initial, notes: "Intended" }); await vi.advanceTimersByTimeAsync(20);
    memory.connectPreferences(account, projectId, saved(3, { ...initial, notes: "Intended" }), context);
    expect(memory.get(account, projectId)?.preferences?.status).toBe("conflict");
    expect(memory.get(account, projectId)?.preferences?.pending?.expectedPreferencesVersion).toBe(1);
  });
  it("retains unfinished invalid fields for explicit recovery without treating them as saved", () => {
    const values = new Map<string, string>(); const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
    const before = createNamingBrainMemory({ storage }); before.bind(account); before.connectPreferences(account, projectId, saved(1), context);
    before.editPreferences(account, projectId, { ...initial, creativeLocale: "F", requiredText: ["unfinished", ""] });
    const after = createNamingBrainMemory({ storage }); after.bind(account); after.recover(account);
    expect(after.get(account, projectId)?.preferences?.draft).toMatchObject({ creativeLocale: "F", requiredText: ["unfinished", ""] });
    expect(after.get(account, projectId)?.preferences?.status).toBe("error");
  });
  it("recovers unsaved choices from an older copy without recovering its generation request", () => {
    const values = new Map<string, string>(); const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
    const draft = { ...initial, notes: "Older tab guidance" };
    values.set(`embel.naming-recovery.v1:${owner}`, JSON.stringify({ version: 1, ownerId: owner, creation: null, projects: [{ projectId, steeringDraft: { candidateIds: [], instruction: "" },
      preferences: { saved: saved(1), draft, pending: null },
      pending: { version: 1, reason: "initial", idempotencyKey: "older-feed-request" }, acknowledged: false, stop: null, steering: null }] }));
    const after = createNamingBrainMemory({ storage }); after.bind(account); after.recover(account);
    expect(after.get(account, projectId)?.preferences).toMatchObject({ draft, dirty: true, status: "error" });
    expect(after.get(account, projectId)?.feed).toMatchObject({ pending: null, stopping: false, error: null });
  });
  it("marks an unconfirmed start as unsaved until its answer arrives", () => {
    const memory = createNamingBrainMemory({ storage: () => null }); memory.bind(account);
    const pending = { version: 2 as const, kind: "initial" as const, expectedProjectRevision: 1, expectedPreferencesVersion: 1, seedIds: [], instruction: null, idempotencyKey: "pending-start-request" };
    memory.setFeed(account, projectId, value => ({ ...value, pending }));
    expect(memory.hasUnsaved()).toBe(true);
    memory.bind({ ...account, generation: 2 });
    expect(memory.get({ ...account, generation: 2 }, projectId)?.feed).toMatchObject({ pending, retry: "start", error: "This request could not be confirmed. Try again." });
  });
  it("I5 recovers an unsubmitted steering draft without marking acknowledged preferences unsaved", () => {
    const values = new Map<string, string>(); const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
    const request = vi.fn(); const before = createNamingBrainMemory({ storage, request }); before.bind(account); before.connectPreferences(account, projectId, saved(1), context);
    before.setSteeringDraft(account, projectId, draft => ({ ...draft, instruction: "Keep a quieter rhythm" }));
    expect(before.hasUnsaved()).toBe(true);
    const after = createNamingBrainMemory({ storage, request }); after.bind(account);
    expect(after.get(account, projectId)).toBeNull(); expect(after.getRecovery(account)).not.toBeNull();
    after.connectPreferences(account, projectId, saved(1), context); after.recover(account);
    expect(after.get(account, projectId)?.steeringDraft).toEqual({ candidateIds: [], instruction: "Keep a quieter rhythm" });
    expect(after.get(account, projectId)?.preferences).toMatchObject({ dirty: false, status: "saved" });
    expect(request).not.toHaveBeenCalled();
  });
});

it("keeps question progress owner-fenced in memory and does not turn it into browser/account work", () => {
  const values = new Map<string, string>(), write = vi.fn((key: string, value: string) => values.set(key, value));
  const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: write, removeItem: (key: string) => values.delete(key) });
  const memory = createNamingBrainMemory({ storage }); memory.bind(account);
  const choices = { ...initial, approaches: ["other_languages" as const], directness: "all" as const };
  memory.connectPreferences(account, projectId, saved(1, choices), context);
  const progress = memory.get(account, projectId)!.chatProgress!;
  expect(progress.activeStep).toBe("length"); expect(Object.keys(progress.confirmed)).toEqual(["approaches", "directness"]);
  memory.setChatProgress(account, projectId, progress);
  expect(memory.hasUnsaved()).toBe(false); expect(write).not.toHaveBeenCalled();
  memory.bind(null); expect(memory.get(account, projectId)).toBeNull();
  const again = { ...account, generation: 2 }; memory.bind(again);
  expect(memory.get(again, projectId)?.chatProgress).toEqual(progress);
  memory.setChatProgress(account, projectId, { ...progress, activeStep: "review" });
  expect(memory.get(again, projectId)?.chatProgress?.activeStep).toBe("length");
  const other = { userId: "a0000000-0000-4000-8000-000000000002", generation: 3 }; memory.bind(other);
  expect(memory.get(other, projectId)).toBeNull(); expect(memory.hasUnsaved()).toBe(false);
});
