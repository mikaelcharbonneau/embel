// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectNamingWorkspace } from "@/components/naming/project-naming-workspace";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { accountProjectSchema } from "@/domain/project-api";
import { projectNamingOverviewSchema, type ProjectNamingOverview } from "@/domain/naming-jobs";
import { getNamingReadiness, nameIdentityKey, namingStrategyBasis, namingStrategyKey, type ProjectNameEntry } from "@/domain/project-naming";
import { initialNamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import { initialNamingView } from "@/components/naming/use-project-naming";

const mock = vi.hoisted(() => ({ memory: null as ReturnType<typeof createNamingBrainMemory> | null, drafts: null as ReturnType<typeof createAccountDraftMemory> | null, current: vi.fn(), expire: vi.fn() }));
const id = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account = { status: "ready" as const, userId: id(1), generation: 1 }, projectId = id(2), when = "2026-10-23T01:30:00Z";
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: account, namingBrainDrafts: mock.memory, drafts: mock.drafts, isCurrent: mock.current, expire: mock.expire }), AccountStatus: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/naming/project-screening-evidence", () => ({ ProjectScreeningEvidence: () => null }));
let host: HTMLDivElement, root: Root, state: ProjectNamingOverview, generated: ProjectNameEntry[], manual: ProjectNameEntry[];
let fetcher: ReturnType<typeof vi.fn>, failImport: boolean, failOverview: boolean, staleCustomRead: ProjectNameEntry[] | null;
const requests: { path: string; method: string; body: Record<string, unknown> | null; account: string | null }[] = [];
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(row => row.textContent?.trim() === name || row.getAttribute("aria-label") === name);
async function click(name: string) { expect(button(name), name).toBeDefined(); await act(async () => button(name)!.click()); }
async function render() { await act(async () => root.render(<ProjectNamingWorkspace projectId={projectId} />)); }
async function enter(text: string) {
  const input = host.querySelector<HTMLInputElement>('form[aria-label="Add your own name"] input')!;
  expect(input.disabled).toBe(false);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
function ownEntry(value: string, n: number): ProjectNameEntry {
  const candidateId = id(n), owned = { ownerId: account.userId, projectId };
  return { candidate: { ...owned, id: candidateId, value, identityKey: nameIdentityKey(value), rationale: "Synthetic retained name", contextRevision: 1, strategyBasis: namingStrategyBasis(state.project.context), strategyKey: namingStrategyKey(state.project.context), createdAt: when,
    origin: { kind: "local_import", ...owned, candidateId, contextRevision: 1, source: { id: candidateId, value, createdAt: when, origin: "manual", history: [] }, capturedContext: state.project.context } }, retention: { ...owned, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null } };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; }); Element.prototype.scrollIntoView = vi.fn();
  mock.memory = createNamingBrainMemory({ storage: () => null }); mock.memory.bind(account); mock.drafts = createAccountDraftMemory();
  mock.current.mockReset().mockImplementation(value => value.userId === account.userId && value.generation === account.generation); mock.expire.mockReset();
  requests.length = 0; manual = []; failImport = false; failOverview = false; staleCustomRead = null;
  const project = accountProjectSchema.parse({ id: projectId, owner_id: account.userId, title: "Synthetic 130 saved names", scope: "naming_only", current_revision: 1, created_at: when, context: { description: "A synthetic kitchen brief" } });
  const owned = { ownerId: account.userId, projectId };
  state = projectNamingOverviewSchema.parse({ project, readiness: getNamingReadiness(project.context, project.scope), session: { ...owned, revision: 1, currentPreferencesVersion: 1, latestBatchSequence: 2, currentSelectionId: null, viewRevision: 1, viewState: initialNamingView, createdAt: when, updatedAt: when }, preferences: { ...owned, version: 1, preferences: { ...initialNamingPreferencesV2(project.context), approaches: ["real_words"], directness: "all" }, createdAt: when }, currentSelection: null, candidates: { ...owned, items: [], nextCursor: null }, batches: { ...owned, items: [], nextCursor: null }, jobs: [], availability: { status: "unavailable", operation: "naming.generate", reason: "worker_unavailable" }, screening: { domains: { status: "not_checked", reason: "integration_unavailable" }, handles: { status: "not_checked", reason: "integration_unavailable" }, trademarks: { status: "not_checked", reason: "integration_unavailable" } } });
  generated = Array.from({ length: 130 }, (_, index) => {
    const entry = ownEntry(`Synthetic ${index + 1}`, index + 100), candidate = entry.candidate;
    return { ...entry, candidate: { ...candidate, origin: { kind: "generated" as const, version: 2 as const, handlerVersion: "naming-brain-v1" as const, ...owned, candidateId: candidate.id, contextRevision: 1, value: candidate.value, batchId: id(5), jobId: id(6), runId: id(7), sourceArtifactId: id(8), sourceStageKey: "creation" as const, stepKey: "prepare" as const, provider: "openai" as const, billingMode: "openai_api" as const, protocol: "openai_agents" as const, model: "synthetic-never-call", sessionId: "synthetic-session", turnId: "synthetic-turn", responseId: null, agentId: null, requestId: null, providerItemId: `synthetic-item-${index}`, generatedAt: when } } };
  });
  fetcher = vi.fn(async (path: string, options: RequestInit) => {
    const url = new URL(path, "https://fixture.invalid"), method = options.method ?? "GET", body = options.body ? JSON.parse(String(options.body)) : null;
    requests.push({ path: url.pathname, method, body, account: new Headers(options.headers).get("X-Embel-Account") });
    const base = `/api/projects/${projectId}/naming`;
    if (url.pathname === `${base}/feed`) return Response.json({}, { status: 503 });
    if (url.pathname === `${base}/custom`) return Response.json(structuredClone({ ...owned, items: staleCustomRead ?? manual, nextCursor: null }));
    if (url.pathname === base) {
      if (failOverview) return Response.json({}, { status: 503 });
      const items = generated.slice(0, 100), last = items.at(-1)?.candidate;
      return Response.json({ ...state, candidates: { ...owned, items, nextCursor: last && generated.length > items.length ? { id: last.id, createdAt: last.createdAt } : null } });
    }
    if (url.pathname === `${base}/imports`) {
      const source = body.source;
      let entry = manual.find(row => row.candidate.origin.kind === "local_import" && row.candidate.origin.source.id === source.id);
      if (!entry) { entry = ownEntry(source.value, 999); entry = { ...entry, candidate: { ...entry.candidate, origin: { kind: "local_import", ...owned, candidateId: entry.candidate.id, contextRevision: 1, source, capturedContext: body.capturedContext } } }; manual.push(entry); }
      if (failImport) { failImport = false; return Response.json({}, { status: 503 }); }
      return Response.json({ entry });
    }
    if (url.pathname === `${base}/view`) { state = { ...state, session: { ...state.session!, viewRevision: body.expectedViewRevision + 1, viewState: body.viewState } }; return Response.json({ session: state.session }); }
    if (url.pathname === `${base}/retention`) {
      const entry = manual[0]!; manual = [{ ...entry, retention: { ...entry.retention, revision: body.expectedRevision + 1, favorite: body.favorite, saved: body.saved, updatedAt: when } }];
      return Response.json({ entry: manual[0] });
    }
    if (url.pathname === `${base}/selection`) {
      const candidate = manual[0]!.candidate, revision = body.expectedRevision + 1;
      const project = { ...state.project, current_revision: revision, context: { ...state.project.context, selectedName: candidate.value, intake: { ...state.project.context.intake, suppliedName: candidate.value } } };
      const selection = { id: id(5000), ...owned, candidateId: candidate.id, projectRevision: revision, previousSelectionId: null, acceptedEarlierContext: false, createdAt: when };
      state = { ...state, project, currentSelection: { selection, candidate }, session: { ...state.session!, currentSelectionId: selection.id } };
      return Response.json({ project, currentSelection: state.currentSelection, session: state.session });
    }
    throw Error(`Unexpected synthetic request ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetcher); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); mock.memory?.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("adds, saves, selects and reloads a custom name after 130 saved generated names while generation reads fail", async () => {
  await render(); await enter("My kitchen name"); await click("Add name");
  expect(manual).toHaveLength(1); expect(generated).toHaveLength(130);
  expect(host.querySelector<HTMLInputElement>('form[aria-label="Add your own name"] input')!.value).toBe("");
  expect(button("Inspect name My kitchen name")).toBeDefined();
  await act(async () => { await root.unmount(); }); root = createRoot(host); await render();
  expect(button("Inspect name My kitchen name")).toBeDefined();
  await click("Inspect name My kitchen name"); await click("Save My kitchen name");
  expect(manual[0]!.retention.saved).toBe(true);
  expect(button("Unsave My kitchen name")).toBeDefined();
  expect(button("Save My kitchen name")).toBeUndefined();
  await click("Favorite My kitchen name");
  expect(manual[0]!.retention.favorite).toBe(true);
  expect(manual[0]!.retention.revision).toBe(2);
  expect(button("Unsave My kitchen name")).toBeDefined();
  expect(button("Unfavorite My kitchen name")).toBeDefined();
  await click("Use this name"); expect(state.currentSelection?.candidate.value).toBe("My kitchen name");
  await act(async () => root.unmount()); root = createRoot(host); await render();
  expect(host.textContent).toContain("My kitchen name"); expect(state.session?.viewState.pane).toBe("screening");
  expect(manual[0]!.retention.saved).toBe(true); expect(generated).toHaveLength(130);
  expect(requests.filter(row => row.method !== "GET").every(row => row.account === account.userId)).toBe(true);
  expect(requests.some(row => row.path.endsWith("/ensure") || row.path.endsWith("/batches"))).toBe(false);
});

it("does not revert acknowledged custom retention when an older custom page arrives", async () => {
  await render(); await enter("Monotonic custom name"); await click("Add name");
  staleCustomRead = structuredClone(manual);
  await click("Inspect name Monotonic custom name"); await click("Save Monotonic custom name");
  expect(button("Unsave Monotonic custom name")).toBeDefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(button("Unsave Monotonic custom name")).toBeDefined();
  await click("Favorite Monotonic custom name");
  expect(manual[0]!.retention).toMatchObject({ revision: 2, saved: true, favorite: true });
  const writes = requests.filter(row => row.path.endsWith("/retention"));
  expect(writes.map(row => row.body?.expectedRevision)).toEqual([0, 1]);
});

it("keeps an empty filtered library reachable when only the independent custom page contains saved names", async () => {
  generated = []; manual = [ownEntry("Custom outside Favorites", 999)];
  state = { ...state, session: { ...state.session!, viewState: { ...initialNamingView, filter: "favorite" } } };
  await render();
  expect(host.querySelector('[data-naming-layout="results"]')).not.toBeNull();
  expect(host.querySelector<HTMLElement>('[aria-label="Naming results workspace"]')?.hidden).toBe(false);
  expect(host.textContent).toContain("No names in this view");
  expect(button("View all names")).toBeDefined();
  expect(button("Inspect name Custom outside Favorites")).toBeUndefined();
  expect(host.querySelector('[aria-label="Your custom names"]')).toBeNull();
  expect(requests.every(row => row.method === "GET")).toBe(true);
});

it("allows a manual save from a verified clean cached overview and retries the exact unconfirmed import", async () => {
  await render(); failOverview = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  await enter("Retained exact name"); failImport = true; await click("Add name");
  expect(button("Retry saving name")).toBeDefined(); expect(manual).toHaveLength(1);
  await click("Retry saving name"); expect(manual).toHaveLength(1);
  const imports = requests.filter(row => row.path.endsWith("/imports"));
  expect(imports).toHaveLength(2); expect(imports[0]!.body).toEqual(imports[1]!.body);
  expect(button("Inspect name Retained exact name")).toBeDefined();
  expect(requests.some(row => row.path.endsWith("/ensure"))).toBe(false);
});
