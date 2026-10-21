// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "@/components/workspace/account-session";
import { LogoCreationWorkspace } from "@/components/logo-creation/logo-creation-workspace";
import { logoOperationSchema, type LogoQuoteRequest, type LogoGenerationIntent, type LogoRequestState } from "@/domain/logo-jobs";
import { logoWorkspaceV2Schema, type LogoRasterSource } from "@/domain/logo-workspace";
import type { LogoDraftMemory } from "@/components/identity/logo-draft-memory";
import { syntheticLogoBatch, syntheticLogoWorkspace, syntheticResolvedLogoConcept, syntheticLogoQuote, logoFixtureId as id } from "../fixtures/logo-creation";
let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function until(check: () => void) { let error: unknown; for (let i = 0; i < 80; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); try { check(); return; } catch (e) { error = e; } } throw error; }
async function mount(refinement = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; }; HTMLDialogElement.prototype.close = function () { this.open = false; };
  const batch = syntheticLogoBatch(), resolved = syntheticResolvedLogoConcept(), base = syntheticLogoWorkspace();
  const selected = refinement ? { kind: "refinement" as const, rasterRevisionId: id(173) } : { kind: "concept" as const, batchId: batch.id, slotId: batch.slots[0]!.id, attemptId: batch.slots[0]!.attempts[0]!.id };
  let concepts = { version: 2, id: id(160), ownerId: base.ownerId, projectId: base.projectId, stage: "concepts", revision: 1, parentRevisionId: null as string | null, inputRevisions: [], inputHash: "b".repeat(64), createdAt: "2026-10-07T00:00:00Z", payload: { batchIds: [batch.id], selected: selected as LogoRasterSource } };
  const approval = { id: id(170), ownerId: base.ownerId, projectId: base.projectId, vectorRevisionId: id(171), stageRevisionId: id(172), approvedAt: "2026-10-07T00:00:00Z" };
  const vector = { ...concepts, id: id(172), stage: "vector", payload: { vectorRevisionId: id(171), approvalId: approval.id } };
  let workspace = logoWorkspaceV2Schema.parse({ ...base, capabilities: { ...base.capabilities, save: { status: "available" } }, approvedLogo: approval, heads: { ...base.heads, workspaceRevision: 3, stageRevisions: { ...base.heads.stageRevisions, brief_references: 1, concepts: 1, vector: 1 } }, stages: { ...base.stages, vector: { stage: "vector", id: vector.id, revision: 1 }, brief_references: { stage: "brief_references", id: resolved.brief.id, revision: 1 }, concepts: { stage: "concepts", id: concepts.id, revision: 1 } } });
  function advanceSelection(source: LogoRasterSource) {
    const previous = concepts;
    concepts = { ...previous, id: id(160 + previous.revision), revision: previous.revision + 1, parentRevisionId: previous.id, payload: { ...previous.payload, selected: source } };
    workspace = logoWorkspaceV2Schema.parse({ ...workspace, heads: { ...workspace.heads, workspaceRevision: workspace.heads.workspaceRevision + 1, stageRevisions: { ...workspace.heads.stageRevisions, concepts: concepts.revision } }, stages: { ...workspace.stages, concepts: { stage: "concepts", id: concepts.id, revision: concepts.revision } } });
  }
  const quotes: LogoQuoteRequest[] = [], admissions: LogoGenerationIntent[] = [], paths: { path: string; method: string }[] = [];
  let requestState: LogoRequestState = { status: "not_found" }, ready = true, memory: LogoDraftMemory | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url), method = init?.method ?? "GET"; paths.push({ path, method });
    if (path === "/api/session") return Response.json({ user: { id: base.ownerId } });
    if (path.endsWith("/capabilities")) { const now = Date.now(); return Response.json({ ownerId: base.ownerId, projectId: base.projectId, observedAt: new Date(now).toISOString(), operations: Object.fromEntries(logoOperationSchema.options.map(operation => [operation, ready && operation === "identity.logo_vectorize" ? { status: "available", expiresAt: new Date(now + 30_000).toISOString() } : { status: "unavailable" }])) }); }
    if (path.endsWith("/concepts/selection")) { const body = JSON.parse(String(init?.body)); advanceSelection({ kind: "concept", batchId: body.batchId, slotId: body.slotId, attemptId: body.attemptId }); return Response.json({ ownerId: base.ownerId, projectId: base.projectId, requestKey: body.requestKey, workspace, revision: concepts }); }
    if (path.endsWith("/quotes")) { const body = JSON.parse(String(init?.body)) as LogoQuoteRequest; quotes.push(body); return Response.json({ ...syntheticLogoQuote(), request: body, expected: body.expected, conceptPlan: null, targetSlotIds: [], provider: null, model: null, engine: { id: "synthetic-vector", version: "1.0", artifactHash: "a".repeat(64), settingsHash: "b".repeat(64) }, externalProviderCostMicrousd: 0, estimatedCostMicrousd: 0, maxCostMicrousd: 0, expiresAt: new Date(Date.now() + 60_000).toISOString() }); }
    if (path.endsWith("/requests")) { const body = JSON.parse(String(init?.body)) as LogoGenerationIntent; admissions.push(body); const receipt = { ownerId: base.ownerId, projectId: base.projectId, requestKey: body.requestKey, operation: "identity.logo_vectorize", batchId: null, jobIds: [id(500)], inputHash: "b".repeat(64) }; requestState = { status: "running", requestKey: body.requestKey, receipt: receipt as never, outputs: [], billing: { status: "unknown", confirmedMicrousd: null }, reason: null }; return Response.json(receipt); }
    if (path.includes("/requests/")) return Response.json(requestState);
    if (path.endsWith("/logo")) return Response.json(workspace);
    if (path.includes("/batches?")) return Response.json({ ownerId: base.ownerId, projectId: base.projectId, items: [{ id: batch.id, requestKey: batch.requestKey, createdAt: batch.createdAt }], nextCursor: null });
    if (path.endsWith(`/batches/${batch.id}`)) return Response.json(batch);
    if (path.endsWith(`/revisions/${resolved.brief.id}`)) return Response.json(resolved.brief);
    if (path.endsWith(`/revisions/${vector.id}`)) return Response.json(vector);
    if (path.endsWith(`/revisions/${concepts.id}`)) return Response.json(concepts);
    if (path.includes("/reference-snapshots/")) return Response.json(resolved.referenceSnapshot);
    return new Response(null, { status: 503 });
  };
  vi.stubGlobal("fetch", fetcher);
  function Harness() { const account = useAccountSession(); useLayoutEffect(() => { memory = account.logoDrafts; }); return createElement(LogoCreationWorkspace, { projectId: base.projectId }); }
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(createElement(AccountSessionProvider, null, createElement(Harness))));
  const button = (text: string) => [...container.querySelectorAll("button")].find(node => node.textContent === text);
  await until(() => expect(container.textContent).toContain("5 of 6 concepts ready"));
  return { container, button, quotes, admissions, paths, advanceSelection, get workspace() { return workspace; }, selected, get memory() { return memory!; }, setReady(value: boolean) { ready = value; } };
}
describe("actual selected-concept conversion UI", () => {
  it("uses vector-only live capability with an explicit estimate then one original admission", async () => {
    const f = await mount(); await until(() => expect(f.button("Review conversion")?.disabled).toBe(false));
    expect(f.button("More concepts")?.disabled).toBe(true); expect(f.admissions).toEqual([]); expect(f.quotes).toEqual([]);
    await act(async () => f.button("Review conversion")!.click());
    await until(() => expect(f.button("Convert to vector")?.disabled).toBe(false));
    expect(f.quotes).toEqual([{ operation: "vectorize", expected: f.workspace.heads, source: f.selected, settings: { preset: "bw", simplify: 0, filterSpeckle: 0, maxColors: 2 } }]);
    expect(f.admissions).toEqual([]); await act(async () => { f.button("Convert to vector")!.click(); f.button("Convert to vector")!.click(); });
    expect(f.admissions).toHaveLength(1); expect(f.memory.get(f.workspace.projectId)?.pendingIntent).toEqual(f.admissions[0]);
    expect(f.memory.get(f.workspace.projectId)?.workspace?.approvedLogo).toEqual(f.workspace.approvedLogo);
    f.setReady(false); await act(async () => f.button("Refresh operation availability")!.click());
    await until(() => expect(f.button("Review conversion")?.disabled).toBe(true));
    const original = f.memory.get(f.workspace.projectId)?.pendingIntent;
    await act(async () => f.button("Check request")!.click());
    expect(f.memory.get(f.workspace.projectId)?.pendingIntent).toEqual(original); expect(f.admissions).toHaveLength(1);
    const explicitWrites = f.paths.filter(item => item.method !== "GET");
    const earlierReads = f.paths.filter(item => item.path.includes(`/requests/${original!.requestKey}`)).length;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 3100)); });
    expect(f.paths.filter(item => item.path.includes(`/requests/${original!.requestKey}`)).length).toBeGreaterThan(earlierReads);
    expect(f.paths.filter(item => item.method !== "GET")).toEqual(explicitWrites);
    expect(f.admissions).toHaveLength(1); expect(f.memory.get(f.workspace.projectId)?.workspace?.approvedLogo).toEqual(f.workspace.approvedLogo);
  });
  it("retains its displayed conversion estimate through readiness failure without admitting from refresh", async () => {
    const f = await mount(); await until(() => expect(f.button("Review conversion")?.disabled).toBe(false));
    await act(async () => f.button("Review conversion")!.click()); await until(() => expect(f.button("Convert to vector")?.disabled).toBe(false));
    f.setReady(false); await act(async () => f.button("Refresh operation availability")!.click());
    await until(() => expect(f.button("Confirm generation")?.disabled).toBe(true));
    expect(f.container.querySelector('dialog[aria-label="Review generation cost"]')?.textContent).toContain("Estimated cost"); expect(f.quotes).toHaveLength(1); expect(f.admissions).toEqual([]);
  });
});


it("quotes the saved refinement source without substituting a displayed concept", async () => {
  const f = await mount(true); await until(() => expect(f.button("Review conversion")?.disabled).toBe(false));
  await act(async () => f.button("Review conversion")!.click()); await until(() => expect(f.quotes).toHaveLength(1));
  expect(f.quotes[0]).toMatchObject({ operation: "vectorize", source: { kind: "refinement", rasterRevisionId: id(173) } });
  expect(f.admissions).toEqual([]); expect(f.memory.get(f.workspace.projectId)?.workspace?.approvedLogo).toEqual(f.workspace.approvedLogo);
});


it("uses a reloaded saved refinement after an earlier concept selection receipt", async () => {
  const f = await mount(); const select = () => f.container.querySelector<HTMLButtonElement>('button[aria-label="Select concept 1"]');
  await until(() => expect(select()?.disabled).toBe(false)); await act(async () => select()!.click());
  await until(() => expect(f.memory.get(f.workspace.projectId)?.workspace?.heads.stageRevisions.concepts).toBe(2));
  const replacement = { kind: "refinement" as const, rasterRevisionId: id(174) }; f.advanceSelection(replacement);
  await until(() => expect(f.button("Refresh saved brand")).toBeDefined());
  await act(async () => f.button("Refresh saved brand")!.click());
  await until(() => expect(f.memory.get(f.workspace.projectId)?.workspace?.heads.stageRevisions.concepts).toBe(3));
  await until(() => expect(f.button("Review conversion")?.disabled).toBe(false));
  expect(f.admissions).toEqual([]); expect(f.quotes).toEqual([]);
  await act(async () => f.button("Review conversion")!.click());
  await until(() => expect(f.quotes).toHaveLength(1)); expect(f.quotes[0]).toMatchObject({ source: replacement, expected: f.workspace.heads });
  expect(f.admissions).toEqual([]);
});
