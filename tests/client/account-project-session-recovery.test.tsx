// @vitest-environment jsdom
// Project-bar progress reads (logo/identity) are answered 404 and not counted.
import { act, useLayoutEffect, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "@/components/workspace/account-session";
import { AccountProjectWorkspaceShell } from "@/components/workspace/project-workspace";
import { AccountProjectEditor } from "@/components/workspace/account-project-editor";
import type { AccountGuidedInterview } from "@/components/workspace/account-guided-interview";
import { accountProjectSchema, type AccountProject } from "@/domain/project-api";
import { guidedMessageContext } from "@/components/workspace/guided-interview-client";
import { getNamingReadiness } from "@/domain/project-naming";
import { strategyJobSchema, type StrategyOverview } from "@/domain/strategy-jobs";
import { contextSnapshotSchema } from "@/domain/projects";

const owner = "aaaaaaaa-1111-4111-8111-111111111111";
const projectId = "bbbbbbbb-1111-4111-8111-111111111111";
const capture = vi.hoisted(() => ({ editor: null as ComponentProps<typeof AccountGuidedInterview> | null, overview: null as StrategyOverview | null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => `/brands/account/bbbbbbbb-1111-4111-8111-111111111111` }));
vi.mock("@/components/workspace/account-project-continuity", () => ({ AccountProjectContinuity: () => null }));
vi.mock("@/components/ideas/idea-source-banner", () => ({ IdeaSourceBanner: () => null }));
vi.mock("@/components/workspace/account-guided-interview", async importOriginal => {
  const actual = await importOriginal<typeof import("@/components/workspace/account-guided-interview")>();
  return { AccountGuidedInterview: (props: ComponentProps<typeof AccountGuidedInterview>) => { capture.editor = props; return <actual.AccountGuidedInterview {...props} />; } };
});
vi.mock("@/components/workspace/use-strategy-jobs", () => ({ useStrategyJobs: () => ({
  overview: capture.overview ?? { jobs: [], availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } },
  pending: false, readError: null, actionError: null, refresh: vi.fn(), enqueue: vi.fn(), cancel: vi.fn(),
}) }));

let account: ReturnType<typeof useAccountSession>;
let root: Root, host: HTMLDivElement, project: AccountProject, fetcher: ReturnType<typeof vi.fn>;
function Probe() { const next = useAccountSession(); useLayoutEffect(() => { account = next; }); return null; }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function mount() {
  await act(async () => root.render(<AccountSessionProvider><Probe /><AccountProjectWorkspaceShell projectId={projectId}><AccountProjectEditor projectId={projectId} /></AccountProjectWorkspaceShell></AccountSessionProvider>));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(account.session.status).toBe("ready"); expect(account.drafts.get(projectId)).not.toBeNull();
  expect(host.querySelectorAll(".project-workspace-header, .project-stage-navigation, .logo-journey-navigation")).toHaveLength(0);
}
async function typePrompt(text: string) {
  await act(async () => {
    const field = host.querySelector<HTMLTextAreaElement>(".conversation-composer textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function retrySave() {
  const retry = [...host.querySelectorAll("button")].find(button => button.textContent === "Retry save")!;
  expect(retry).toBeDefined();
  await act(async () => retry.click());
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); capture.editor = null; capture.overview = null;
  project = accountProjectSchema.parse({ id: projectId, owner_id: owner, scope: "complete_brand", title: "Recovery repro", current_revision: 1, created_at: "2026-10-15T00:00:00Z", context: { description: "A neighborhood lunch kitchen" } });
  fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (path === "/api/session") return Response.json({ user: { id: owner } });
    if (path === `/api/projects/${projectId}` && init.method === "GET") return Response.json({ project });
    throw new Error("Unexpected synthetic request");
  });
  vi.stubGlobal("fetch", fetcher); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([0, 1])("keeps an unacknowledged guided answer after same-owner verification when read %s resolves first", async first => {
  await mount();
  const pending = guidedMessageContext(project.context, "Do not lose this unsaved answer", 2);
  fetcher.mockImplementationOnce(async () => { throw new TypeError("Synthetic interrupted save before commit"); });
  await act(async () => { await capture.editor!.saveContext(pending); });
  expect(account.drafts.hasUnsaved()).toBe(true);
  const reads: ReturnType<typeof deferred<Response>>[] = [];
  fetcher.mockImplementation(async (path: string) => {
    if (path === "/api/session") return Response.json({ user: { id: owner } });
    const read = deferred<Response>(); reads.push(read); return read.promise;
  });
  await act(async () => account.refresh());
  expect(account.session).toMatchObject({ status: "ready", userId: owner, generation: 2 });
  expect(reads).toHaveLength(2);
  // The child editor starts read 0, then the parent shell starts read 1.
  await act(async () => reads[first]!.resolve(Response.json({ project })));
  expect(account.drafts.get(projectId)!.pendingGuidedContext).toEqual(pending);
  expect(account.drafts.hasUnsaved()).toBe(true);
  await act(async () => reads[1 - first]!.resolve(Response.json({ project })));
  expect(host.textContent).toContain("Do not lose this unsaved answer");
  expect(account.drafts.get(projectId)!.saved.current_revision).toBe(1);
  expect(account.drafts.get(projectId)!.generation).toBe(2);
  expect(host.textContent).toContain("Retry save");
});

it("keeps unsent conversation text through same-owner verification and protects unsaved exit", async () => {
  await mount();
  await typePrompt("Please keep my unsent message");
  expect(host.querySelector<HTMLTextAreaElement>(".conversation-composer textarea")!.value).toBe("Please keep my unsent message");
  expect(account.drafts.hasUnsaved()).toBe(true);
  const beforeUnload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(beforeUnload);
  expect(beforeUnload.defaultPrevented).toBe(true);
  await act(async () => account.refresh());
  expect(account.session).toMatchObject({ status: "ready", userId: owner, generation: 2 });
  expect(host.querySelector<HTMLTextAreaElement>(".conversation-composer textarea")!.value).toBe("Please keep my unsent message");
  expect(account.drafts.hasUnsaved()).toBe(true);
  expect(await account.signOut()).toEqual({ ok: false, reason: "confirmation_required" });
  expect(fetcher.mock.calls.filter(([, init]) => init.method !== "GET")).toHaveLength(0);
});

it("acknowledges an exact committed guided answer on retry without another PATCH", async () => {
  await mount();
  let patches = 0;
  fetcher.mockImplementation(async (path: string, init: RequestInit) => {
    if (path === "/api/session") return Response.json({ user: { id: owner } });
    if (init.method === "GET") return Response.json({ project });
    patches++;
    if (patches > 1) return new Response(null, { status: 409 });
    const body = JSON.parse(String(init.body));
    project = { ...project, current_revision: 2, context: body.context };
    throw new TypeError("Synthetic lost acknowledgement after commit");
  });
  const pending = guidedMessageContext(project.context, "Already committed answer", 2);
  await act(async () => { await capture.editor!.saveContext(pending); });
  expect(project.current_revision).toBe(2); expect(account.drafts.get(projectId)!.pendingGuidedContext).toEqual(project.context);
  expect(account.drafts.get(projectId)!.saved.current_revision).toBe(1);
  await retrySave();
  expect(patches).toBe(1); expect(account.drafts.get(projectId)!.conflict).toBe(false);
  expect(host.textContent).not.toContain("A newer version is saved in your account.");
  expect(account.drafts.get(projectId)!.saved.current_revision).toBe(2);
  expect(account.drafts.hasUnsaved()).toBe(false);
});

it.each([false, true])("withholds the final saved-strategy notice until an exact acknowledgement (committed before failed reply: %s)", async committed => {
  const now = "2026-10-15T00:00:00Z";
  const turns = (["competitors", "audience", "personality"] as const).map((stage, index) => ({ id: `saved-${stage}`, userMessageId: null, stage, purpose: "propose", inputRevision: index + 1 }));
  const answers = turns.map(turn => ({ stage: turn.stage, turnId: turn.id, optionIds: [`choice-${turn.stage}`], customText: null, confirmedAt: now }));
  project = accountProjectSchema.parse({ ...project, current_revision: 3, context: { ...project.context,
    competitorReviewComplete: true,
    audienceSegments: [{ id: "eeeeeeee-1111-4111-8111-111111111111", label: "Neighbors", needs: ["A convenient lunch"], reason: "Nearby regulars", origin: "proposal", selected: true, sources: [] }],
    intake: { ...project.context.intake, audienceReviewedAt: now, guidedInterview: { version: 1, stage: "personality", turns, answers: answers.slice(0, 2) } },
  } });
  const complete = contextSnapshotSchema.parse({ ...project.context,
    personality: { sincerity: 80, excitement: 40, competence: 80, sophistication: 30, ruggedness: 10 },
    intake: { ...project.context.intake, personalityReviewedAt: now, guidedInterview: { ...project.context.intake.guidedInterview!, stage: "complete", answers } },
  });
  await mount();
  const notice = "Your brand strategy is saved. You can revisit any answer above.";
  expect(host.textContent).not.toContain(notice);
  const response = deferred<Response>();
  const writes = { patches: 0 };
  fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
    if (/\/(logo|identity)(\/|\?|$)/.test(_path)) return new Response(null, { status: 404 });
    expect(init.method).toBe("PATCH"); writes.patches++;
    expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: 3, context: complete });
    return response.promise;
  });
  let saving!: Promise<unknown>;
  await act(async () => { saving = capture.editor!.saveContext(complete); });
  expect(account.drafts.get(projectId)!.pendingGuidedContext).toEqual(complete);
  expect(account.drafts.hasUnsaved()).toBe(true);
  expect(host.textContent).toContain("Saving…");
  expect(host.textContent).not.toContain(notice);
  if (committed) project = { ...project, current_revision: 4, context: complete };
  await act(async () => { response.resolve(new Response(null, { status: 503 })); await saving; });
  expect(account.drafts.hasUnsaved()).toBe(true);
  expect(host.textContent).not.toContain(notice);
  expect(host.textContent).toContain("Retry save");
  fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
    if (/\/(logo|identity)(\/|\?|$)/.test(_path)) return new Response(null, { status: 404 });
    if (init.method === "GET") return Response.json({ project });
    expect(init.method).toBe("PATCH"); writes.patches++;
    expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: 3, context: complete });
    project = { ...project, current_revision: 4, context: complete };
    return Response.json({ revision: { project_id: projectId, owner_id: owner, revision: 4, context: complete, input_hash: "a".repeat(64), created_at: now } });
  });
  await retrySave();
  expect(writes.patches).toBe(committed ? 1 : 2);
  expect(account.drafts.get(projectId)!.pendingGuidedContext).toBeUndefined();
  expect(account.drafts.hasUnsaved()).toBe(false);
  expect(account.drafts.get(projectId)!.saved.current_revision).toBe(4);
  // The acknowledged handoff opens Naming; do not dump Strategy outside its scroll container while Naming loads.
  expect(host.querySelector('[aria-label="Naming composer"]')).not.toBeNull();
  const acknowledged = account.drafts.get(projectId)!;
  await act(async () => { account.drafts.set({ ...acknowledged, conflict: true }); });
  expect(account.drafts.get(projectId)!.conflict).toBe(true);
  expect(account.drafts.get(projectId)!.saved).toBe(acknowledged.saved);
  expect(account.drafts.get(projectId)!.draft).toBe(acknowledged.draft);
  expect(host.textContent).toContain("A newer project version is saved. Your edits are kept in this tab.");
  expect(host.textContent).not.toContain(notice);
});

it.each([0, 1])("acknowledges a committed guided save during re-verification when read %s resolves first", async first => {
  await mount();
  const pending = guidedMessageContext(project.context, "Saved answer with a lost response", 2);
  let patches = 0;
  fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
    if (/\/(logo|identity)(\/|\?|$)/.test(_path)) return new Response(null, { status: 404 });
    expect(init.method).toBe("PATCH"); patches++;
    project = { ...project, current_revision: 2, context: JSON.parse(String(init.body)).context };
    throw new TypeError("Lost committed acknowledgement");
  });
  await act(async () => { await capture.editor!.saveContext(pending); });
  const reads: ReturnType<typeof deferred<Response>>[] = [];
  fetcher.mockImplementation(async (path: string) => {
    if (path === "/api/session") return Response.json({ user: { id: owner } });
    const read = deferred<Response>(); reads.push(read); return read.promise;
  });
  await act(async () => account.refresh());
  expect(reads).toHaveLength(2);
  await act(async () => reads[first]!.resolve(Response.json({ project })));
  expect(account.drafts.get(projectId)!.saved.current_revision).toBe(2);
  expect(account.drafts.hasUnsaved()).toBe(false);
  await act(async () => reads[1 - first]!.resolve(Response.json({ project })));
  expect(account.drafts.get(projectId)!.pendingGuidedContext).toBeUndefined();
  expect(host.textContent).toContain("Saved answer with a lost response");
  expect(host.textContent).not.toContain("A newer version is saved in your account.");
  expect(patches).toBe(1);
});

it("keeps a newer acknowledged project when an earlier editor GET settles after the shell read", async () => {
  await mount();
  const older = project;
  await act(async () => capture.editor!.storage.onUpdate({ description: "An ordinary edit with a lost response" }));
  let patches = 0;
  fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
    if (/\/(logo|identity)(\/|\?|$)/.test(_path)) return new Response(null, { status: 404 });
    expect(init.method).toBe("PATCH"); patches++;
    const body = JSON.parse(String(init.body));
    project = { ...project, title: body.title, current_revision: 2, context: body.context };
    throw new TypeError("Lost ordinary acknowledgement");
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(650); });
  const reads: ReturnType<typeof deferred<Response>>[] = [];
  fetcher.mockImplementation(async (path: string) => {
    if (path === "/api/session") return Response.json({ user: { id: owner } });
    const read = deferred<Response>(); reads.push(read); return read.promise;
  });
  await act(async () => account.refresh());
  await act(async () => reads[1]!.resolve(Response.json({ project })));
  expect(account.drafts.get(projectId)!.saved.current_revision).toBe(2);
  await act(async () => reads[0]!.resolve(Response.json({ project: older })));
  expect(account.drafts.get(projectId)!.saved.current_revision).toBe(2);
  expect(account.drafts.get(projectId)!.draft.description).toBe("An ordinary edit with a lost response");
  expect(account.drafts.hasUnsaved()).toBe(false); expect(patches).toBe(1);
});

it("hides an unsent message while identity is checking and restores only the same verified owner", async () => {
  await mount(); await typePrompt("Private unsent text");
  const verification = deferred<Response>();
  fetcher.mockImplementation(async (path: string) => path === "/api/session" ? verification.promise : Response.json({ project }));
  await act(async () => account.refresh());
  expect(account.session.status).toBe("checking");
  expect(host.querySelector<HTMLTextAreaElement>(".conversation-composer textarea")).toBeNull(); expect(host.textContent).not.toContain("Private unsent text");
  expect(account.drafts.hasUnsaved()).toBe(true);
  await act(async () => verification.resolve(Response.json({ user: { id: owner } })));
  expect(host.querySelector<HTMLTextAreaElement>(".conversation-composer textarea")!.value).toBe("Private unsent text");
  const otherOwner = "dddddddd-1111-4111-8111-111111111111";
  fetcher.mockImplementation(async (path: string) => path === "/api/session" ? Response.json({ user: { id: otherOwner } }) : new Response(null, { status: 404 }));
  await act(async () => account.refresh());
  expect(account.session).toMatchObject({ status: "ready", userId: otherOwner });
  expect(account.drafts.get(projectId)).toBeNull(); expect(account.drafts.hasUnsaved()).toBe(false);
  expect(host.textContent).not.toContain("Private unsent text");
  fetcher.mockImplementation(async (path: string) => path === "/api/session" ? Response.json({ user: { id: owner } }) : Response.json({ project }));
  await act(async () => account.refresh());
  expect(host.querySelector<HTMLTextAreaElement>(".conversation-composer textarea")!.value).toBe("");
});

it("cannot republish a late guided PATCH after another owner has been verified", async () => {
  await mount(); await typePrompt("Earlier owner's private text");
  const pending = guidedMessageContext(project.context, "Earlier owner's private answer", 2);
  const reply = deferred<Response>();
  fetcher.mockImplementationOnce(async () => reply.promise);
  let saving!: Promise<unknown>;
  await act(async () => { saving = capture.editor!.saveContext(pending); });
  expect(account.drafts.hasUnsaved()).toBe(true);
  const otherOwner = "dddddddd-1111-4111-8111-111111111111";
  fetcher.mockImplementation(async (path: string) => path === "/api/session" ? Response.json({ user: { id: otherOwner } }) : new Response(null, { status: 404 }));
  await act(async () => account.refresh());
  await act(async () => { reply.resolve(Response.json({ revision: { project_id: projectId, owner_id: owner, revision: 2, context: pending, input_hash: "a".repeat(64), created_at: "2026-10-15T00:00:00Z" } })); await saving; });
  expect(account.drafts.get(projectId)).toBeNull(); expect(account.drafts.hasUnsaved()).toBe(false);
  expect(host.textContent).not.toContain("Earlier owner's private");
});

it("retries an uncommitted guided intent with the same body only after checking the saved head", async () => {
  await mount();
  const requests: { method: string; body?: string }[] = [];
  fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
    if (/\/(logo|identity)(\/|\?|$)/.test(_path)) return new Response(null, { status: 404 });
    requests.push({ method: String(init.method), body: init.body ? String(init.body) : undefined });
    if (init.method === "GET") return Response.json({ project });
    if (requests.length === 1) throw new TypeError("Synthetic interrupted request before commit");
    const body = JSON.parse(String(init.body)); project = { ...project, context: body.context, current_revision: 2 };
    return Response.json({ revision: { project_id: projectId, owner_id: owner, revision: 2, context: body.context, input_hash: "a".repeat(64), created_at: "2026-10-15T00:00:00Z" } });
  });
  const pending = guidedMessageContext(project.context, "Retry this exact intended answer", 2);
  await act(async () => { await capture.editor!.saveContext(pending); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(requests.map(item => item.method)).toEqual(["PATCH"]);
  await retrySave();
  expect(requests.map(item => item.method)).toEqual(["PATCH", "GET", "PATCH"]);
  expect(requests[2]!.body).toBe(requests[0]!.body);
  expect(account.drafts.hasUnsaved()).toBe(false);
});

it("keeps a guided branch in conflict when a different saved answer owns the next revision", async () => {
  await mount();
  let patches = 0;
  fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
    if (/\/(logo|identity)(\/|\?|$)/.test(_path)) return new Response(null, { status: 404 });
    if (init.method === "GET") return Response.json({ project });
    patches++; project = { ...project, current_revision: 2, context: { ...project.context, description: "Another tab's saved brief" } };
    throw new TypeError("Uncertain guided save");
  });
  const pending = guidedMessageContext(project.context, "My answer still needs to be kept", 2);
  await act(async () => { await capture.editor!.saveContext(pending); }); await retrySave();
  expect(patches).toBe(1); expect(account.drafts.get(projectId)!.conflict).toBe(true);
  expect(account.drafts.get(projectId)!.pendingGuidedContext).toEqual(pending);
  expect(account.drafts.hasUnsaved()).toBe(true); expect(host.textContent).toContain("My answer still needs to be kept");
  expect(host.textContent).toContain("A newer version is saved in your account.");
});

function seedAudienceChoices() {
  const turn = { id: "audience-choice", userMessageId: null, stage: "audience", purpose: "propose", inputRevision: 1 };
  project = accountProjectSchema.parse({ ...project, context: { ...project.context, intake: { ...project.context.intake, guidedInterview: { version: 1, stage: "audience", turns: [turn], answers: [] } } } });
  const audience = { id: "eeeeeeee-1111-4111-8111-111111111111", label: "Neighbors", needs: ["A convenient lunch"], reason: "They live close to the kitchen", selected: false, origin: "proposal", sources: [] };
  const job = strategyJobSchema.parse({
    id: "cccccccc-1111-4111-8111-111111111111", owner_id: owner, project_id: projectId, operation: "strategy.audience", input_revision: 1,
    state: "succeeded", progress: 100, error_code: null, cancel_requested_at: null, created_at: "2026-10-15T00:00:00Z", finished_at: "2026-10-15T00:00:00Z", reserved_cost_microusd: 1000, actual_cost_microusd: 100,
    results: [{ stepKey: "guided", output: {
      version: 1, provider: "openai", model: "local-fixture", responseId: "synthetic-choice", requestId: null, generatedAt: "2026-10-15T00:00:00Z",
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, webSearchCalls: 0 }, operation: "strategy.audience",
      proposal: { message: "Synthetic audience guidance", segments: [audience] },
      guidance: { kind: "choices", turnId: turn.id, stage: "audience", message: "Choose a target audience.", question: "Who should we serve?", selectionMode: "multiple", options: [
        { id: audience.id, stage: "audience", label: "Neighbors", description: "People living nearby", recommended: true, recommendationReason: "Their daily routine fits a local lunch kitchen.", payload: audience },
      ] },
    } }],
  });
  capture.overview = { jobs: [job], availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } };
}

it("keeps an unconfirmed choice across same-owner verification without treating it as a saved answer", async () => {
  seedAudienceChoices();
  await mount();
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  expect(account.drafts.hasUnsaved()).toBe(true);
  await act(async () => account.refresh());
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(false);
  expect(project.context.intake.guidedInterview!.answers).toHaveLength(0);
  expect(fetcher.mock.calls.filter(([, init]) => init.method !== "GET")).toHaveLength(0);
});

it.each([false, true])("clears only the acknowledged submitted prompt after guided recovery (new typing: %s)", async newerTyping => {
  capture.overview = { jobs: [], availability: { status: "available", operations: [{ operation: "strategy.competitors", maximumCostMicrousd: 1000, interviewVersion: 1 }] } };
  await mount(); await typePrompt("The submitted question");
  let patches = 0;
  fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
    if (/\/(logo|identity)(\/|\?|$)/.test(_path)) return new Response(null, { status: 404 });
    if (init.method === "GET") return Response.json({ project });
    patches++; project = { ...project, current_revision: 2, context: JSON.parse(String(init.body)).context };
    throw new TypeError("Lost submitted prompt acknowledgement");
  });
  await act(async () => host.querySelector<HTMLButtonElement>('button[title="Send prompt"]')!.click());
  expect(host.querySelector<HTMLTextAreaElement>(".conversation-composer textarea")!.value).toBe("The submitted question");
  if (newerTyping) await typePrompt("A different unsent question");
  await retrySave();
  expect(patches).toBe(1);
  expect(project.context.intake.conversation).toHaveLength(1);
  expect(project.context.intake.conversation![0]).toMatchObject({ text: "The submitted question" });
  expect(host.querySelector<HTMLTextAreaElement>(".conversation-composer textarea")!.value).toBe(newerTyping ? "A different unsent question" : "");
  expect(account.drafts.hasUnsaved()).toBe(newerTyping);
});

it.each([false, true])("retains the rejected guided prompt intent through a 429 and clears only its acknowledged input (new typing: %s)", async newerTyping => {
  capture.overview = { jobs: [], availability: { status: "available", operations: [{ operation: "strategy.competitors", maximumCostMicrousd: 1000, interviewVersion: 1 }] } };
  await mount(); await typePrompt("A submitted question after rate limiting");
  const requests: { method: string; body: string | null }[] = [];
  let rejected = false;
  fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
    if (/\/(logo|identity)(\/|\?|$)/.test(_path)) return new Response(null, { status: 404 });
    requests.push({ method: String(init.method), body: init.body ? String(init.body) : null });
    if (init.method === "GET") return Response.json({ project });
    if (!rejected) { rejected = true; return new Response(null, { status: 429 }); }
    const body = JSON.parse(String(init.body)); project = { ...project, current_revision: 2, context: body.context };
    return Response.json({ revision: { project_id: projectId, owner_id: owner, revision: 2, context: body.context, input_hash: "a".repeat(64), created_at: "2026-10-15T00:00:00Z" } });
  });
  await act(async () => host.querySelector<HTMLButtonElement>('button[title="Send prompt"]')!.click());
  expect(project.current_revision).toBe(1); expect(account.drafts.hasUnsaved()).toBe(true);
  if (newerTyping) await typePrompt("Keep this different unsent question");
  await retrySave();
  expect(requests.map(item => item.method)).toEqual(["PATCH", "GET", "PATCH"]);
  expect(requests[2]!.body).toBe(requests[0]!.body);
  expect(project.context.intake.conversation).toHaveLength(1);
  expect(project.context.intake.conversation![0]).toMatchObject({ text: "A submitted question after rate limiting" });
  expect(host.querySelector<HTMLTextAreaElement>(".conversation-composer textarea")!.value).toBe(newerTyping ? "Keep this different unsent question" : "");
  expect(account.drafts.hasUnsaved()).toBe(newerTyping);
  if (newerTyping) { await typePrompt(""); expect(account.drafts.hasUnsaved()).toBe(false); }
});

it.each([false, true])("retains rejected choice metadata through a 429 and acknowledges only that choice (new typing: %s)", async newerTyping => {
  seedAudienceChoices(); await mount();
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const requests: { method: string; body: string | null }[] = [];
  let rejected = false;
  fetcher.mockImplementation(async (_path: string, init: RequestInit) => {
    if (/\/(logo|identity)(\/|\?|$)/.test(_path)) return new Response(null, { status: 404 });
    requests.push({ method: String(init.method), body: init.body ? String(init.body) : null });
    if (init.method === "GET") return Response.json({ project });
    if (!rejected) { rejected = true; return new Response(null, { status: 429 }); }
    const body = JSON.parse(String(init.body)); project = { ...project, current_revision: 2, context: body.context };
    return Response.json({ revision: { project_id: projectId, owner_id: owner, revision: 2, context: body.context, input_hash: "a".repeat(64), created_at: "2026-10-15T00:00:00Z" } });
  });
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Continue")!.click());
  expect(project.current_revision).toBe(1); expect(account.drafts.hasUnsaved()).toBe(true);
  if (newerTyping) await typePrompt("Keep this unsent follow-up to my choice");
  await retrySave();
  expect(requests.map(item => item.method)).toEqual(["PATCH", "GET", "PATCH"]);
  expect(requests[2]!.body).toBe(requests[0]!.body);
  expect(project.context.intake.guidedInterview!.answers).toEqual([expect.objectContaining({ turnId: "audience-choice", stage: "audience", optionIds: ["eeeeeeee-1111-4111-8111-111111111111"] })]);
  expect(project.context.audienceSegments.filter(segment => segment.selected).map(segment => segment.label)).toEqual(["Neighbors"]);
  expect(host.querySelector<HTMLTextAreaElement>(".conversation-composer textarea")!.value).toBe(newerTyping ? "Keep this unsent follow-up to my choice" : "");
  expect(account.drafts.hasUnsaved()).toBe(newerTyping);
  if (newerTyping) { await typePrompt(""); expect(account.drafts.hasUnsaved()).toBe(false); }
});
