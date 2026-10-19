import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { createNamingFeedController } from "@/components/naming/naming-feed-controller";
import { initialNamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import { contextSnapshotSchema } from "@/domain/projects";
import type { NamingPreferenceRevision } from "@/domain/project-naming";
import type { EnsureNamingRunIntent, NamingFeed } from "@/domain/naming-brain";
import { account, feed, id, projectId, run, when } from "./naming-progressive-fixture";

const context = contextSnapshotSchema.parse({ description: "Synthetic recovery-only project" });
const choices = { ...initialNamingPreferencesV2(context), approaches: ["real_words" as const], directness: "all" as const };
const saved = (project = projectId): NamingPreferenceRevision => ({ ownerId: account.userId, projectId: project, version: 1, preferences: choices, createdAt: when });
const intent: EnsureNamingRunIntent = { version: 1, reason: "initial", expectedProjectRevision: 1, expectedPreferencesVersion: 1,
  expectedSteeringRevision: 0, expectedDemandSequence: 0, consumedThrough: null, idempotencyKey: id(900) };
const recoveryKey = `embel.naming-recovery.v1:${account.userId}`;
function storageFixture() {
  const values = new Map<string, string>();
  const storage = () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  return { values, storage };
}
function recoveryProject(project = projectId) {
  return { projectId: project, preferences: null as { saved: NamingPreferenceRevision; draft: typeof choices; pending: null } | null,
    steeringDraft: { candidateIds: [], instruction: "" }, pending: intent as EnsureNamingRunIntent | null,
    acknowledged: true, acknowledgedRunId: id(10) as string | null, stop: null, stopConflict: false, stopRequested: false, steering: null };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("retires the recovery copy after a durable admission ACK and reloads by GET without blocking another project's choices", async () => {
  const { values, storage } = storageFixture();
  const initial = { ...feed([]), activeRun: null, demandSequence: 0, feedbackRevision: 0, consumedThrough: null };
  delete initial.canPrefetchOnScroll;
  const activeRun = { ...run("running"), demandSequence: 0, feedbackRevision: 0 };
  let latest: NamingFeed = initial;
  const request = vi.fn(async (path: string) => {
    if (path.endsWith("/feed/ensure")) {
      latest = { ...initial, activeRun, progressive: { version: 1, targetCount: 100, publishedCount: 0 } };
      return { status: "pending", feed: latest, run: activeRun, reused: false };
    }
    return { feed: latest };
  });
  const before = createNamingBrainMemory({ storage }); before.bind(account); before.connectPreferences(account, projectId, saved(), context);
  const controller = createNamingFeedController({ account, projectId, memory: before, request: request as never, eligible: () => true });
  expect(await controller.start()).toBe(true);
  expect(before.get(account, projectId)?.feed).toMatchObject({ acknowledged: true, acknowledgedRunId: activeRun.runId });
  expect(before.get(account, projectId)?.feed.pending).not.toBeNull();
  expect(before.hasUnsaved()).toBe(false); expect(values.has(recoveryKey)).toBe(false);
  controller.dispose();

  const after = createNamingBrainMemory({ storage }); after.bind(account);
  expect(after.getRecovery(account)).toBeNull(); expect(after.get(account, projectId)).toBeNull();
  after.connectPreferences(account, projectId, saved(), context);
  const reload = createNamingFeedController({ account, projectId, memory: after, request: request as never, eligible: () => true });
  await reload.load(); await reload.poll();
  expect(after.get(account, projectId)?.feed).toMatchObject({ pending: null, status: "pending", acknowledged: false });
  expect(after.get(account, projectId)?.feed.feed?.activeRun?.runId).toBe(activeRun.runId);
  expect(request.mock.calls.filter(([path]) => path.endsWith("/feed/ensure"))).toHaveLength(1);

  const freshProject = id(80);
  after.connectPreferences(account, freshProject, null, context);
  after.editPreferences(account, freshProject, choices);
  expect(after.get(account, freshProject)?.preferences).toMatchObject({ dirty: true, draft: choices });
  reload.dispose();
});

it("removes an already-written unacknowledged copy as soon as that exact run is acknowledged", () => {
  const { values, storage } = storageFixture(), memory = createNamingBrainMemory({ storage }); memory.bind(account);
  memory.setFeed(account, projectId, value => ({ ...value, pending: intent, acknowledged: false }));
  expect(values.has(recoveryKey)).toBe(true); expect(memory.hasUnsaved()).toBe(true);
  memory.setFeed(account, projectId, value => ({ ...value, acknowledged: true, acknowledgedRunId: id(10) }));
  expect(values.has(recoveryKey)).toBe(false); expect(memory.hasUnsaved()).toBe(false);
  expect(memory.get(account, projectId)?.feed.pending).toEqual(intent);
});

it.each([true, false])("prunes a legacy ACK-only buffer after owner verification (saved run ID present: %s)", hasRunId => {
  const { values, storage } = storageFixture(), item = recoveryProject();
  const legacy = hasRunId ? item : Object.fromEntries(Object.entries(item).filter(([key]) => key !== "acknowledgedRunId"));
  values.set(recoveryKey, JSON.stringify({ version: 1, ownerId: account.userId, projects: [legacy], creation: null }));
  const request = vi.fn(), memory = createNamingBrainMemory({ storage, request });
  expect(memory.getRecovery(account)).toBeNull(); expect(values.has(recoveryKey)).toBe(true);
  memory.bind(account);
  expect(memory.getRecovery(account)).toBeNull(); expect(memory.get(account, projectId)).toBeNull();
  expect(values.has(recoveryKey)).toBe(false); expect(request).not.toHaveBeenCalled();
  memory.connectPreferences(account, id(80), saved(id(80)), context);
  memory.editPreferences(account, id(80), { ...choices, notes: "A real new edit" });
  expect(memory.get(account, id(80))?.preferences?.draft.notes).toBe("A real new edit");
});

it("prunes only durable run copies from a mixed legacy buffer and preserves drafts, exact uncertain requests, steering, Stop and creation", () => {
  const { values, storage } = storageFixture();
  const draftProject = id(81), uncertainProject = id(82), stopProject = id(83), steeringProject = id(84), unsentProject = id(85);
  const preferences = { saved: saved(draftProject), draft: { ...choices, notes: "Unsaved private choices" }, pending: null };
  const uncertain = { ...recoveryProject(uncertainProject), acknowledged: false, acknowledgedRunId: null };
  const stop = { version: 1, expectedDemandSequence: 2, pendingEnsureIdempotencyKey: intent.idempotencyKey, idempotencyKey: id(901) };
  const steering = { candidateIds: [id(903)], instruction: "An uncertain direction", expectedProjectRevision: 1, expectedPreferencesVersion: 1, expectedSteeringRevision: 0, idempotencyKey: id(902) };
  const creation = { description: "An unsaved new project", direction: "A quieter direction", language: "English", input: null, projectId: null };
  values.set(recoveryKey, JSON.stringify({ version: 1, ownerId: account.userId, creation, projects: [recoveryProject(),
    { ...recoveryProject(draftProject), preferences }, uncertain,
    { ...recoveryProject(stopProject), stop, stopRequested: true },
    { ...recoveryProject(steeringProject), steering },
    { ...recoveryProject(unsentProject), steeringDraft: { candidateIds: [], instruction: "Unsubmitted direction" } },
  ] }));
  const request = vi.fn(), memory = createNamingBrainMemory({ storage, request }); memory.bind(account);
  const recovery = memory.getRecovery(account)!;
  expect(recovery.projects.map(item => item.projectId)).toEqual([draftProject, uncertainProject, stopProject, steeringProject, unsentProject]);
  expect(recovery.projects.find(item => item.projectId === draftProject)).toMatchObject({ preferences, pending: null, acknowledged: false, acknowledgedRunId: null });
  expect(recovery.projects.find(item => item.projectId === uncertainProject)?.pending).toEqual(intent);
  expect(recovery.projects.find(item => item.projectId === stopProject)?.stop).toEqual(stop);
  expect(recovery.projects.find(item => item.projectId === steeringProject)?.steering).toEqual(steering);
  expect(recovery.creation).toEqual(creation);
  expect(JSON.parse(values.get(recoveryKey)!).projects).toHaveLength(5);
  expect(memory.get(account, draftProject)).toBeNull(); expect(request).not.toHaveBeenCalled();
  memory.recover(account);
  expect(memory.get(account, draftProject)?.preferences).toMatchObject({ dirty: true, draft: preferences.draft, status: "error" });
  expect(memory.get(account, uncertainProject)?.feed).toMatchObject({ pending: intent, acknowledged: false, status: "error" });
  expect(memory.get(account, stopProject)?.feed).toMatchObject({ stop, stopRequested: true, status: "error" });
  expect(memory.get(account, steeringProject)?.feed.steering).toEqual(steering);
  expect(memory.get(account, unsentProject)?.steeringDraft.instruction).toBe("Unsubmitted direction");
  expect(memory.getEntry(account)?.description).toBe(creation.description); expect(request).not.toHaveBeenCalled();
});

it("does not attach another owner's genuine recovery while pruning this owner's ACK-only data", () => {
  const { values, storage } = storageFixture(), other = { userId: id(99), generation: 2 };
  values.set(recoveryKey, JSON.stringify({ version: 1, ownerId: account.userId, projects: [{ ...recoveryProject(), acknowledged: false }], creation: null }));
  const memory = createNamingBrainMemory({ storage }); memory.bind(other);
  expect(memory.getRecovery(other)).toBeNull(); expect(memory.get(other, projectId)).toBeNull(); expect(values.has(recoveryKey)).toBe(true);
  memory.bind({ ...account, generation: 3 });
  expect(memory.getRecovery({ ...account, generation: 3 })?.projects[0]?.pending).toEqual(intent);
  expect(memory.getRecovery(other)).toBeNull(); expect(memory.get({ ...account, generation: 3 }, projectId)).toBeNull();
});
