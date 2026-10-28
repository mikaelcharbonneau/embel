// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IdentityGeneration } from "@/components/identity/identity-generation";
import { createIdentityGenerationController, EMPTY_IDENTITY_GENERATION } from "@/components/identity/identity-generation-controller";
import { createIdentityDraftMemory } from "@/components/identity/identity-draft-memory";
import { identityBatchStateSchema } from "@/domain/identity-jobs";
import { initialIdentityPreferences } from "@/domain/project-identity";
import { IMAGE_MODEL } from "@/domain/providers";
import { fixtureInput, fixtureId, fixtureOverview, fixtureOwner as ownerId, fixtureProject as projectId } from "./project-identity-fixtures";
let root: Root, host: HTMLDivElement, identity: ComponentProps<typeof IdentityGeneration>["identity"];
const start = vi.fn(), refresh = vi.fn(), retry = vi.fn(), closeOriginal = vi.fn(), stop = vi.fn();
const intent = { version: 2 as const, spendControl: "uncapped" as const, expectedProjectRevision: 1, expectedReferenceRevision: 1,
  expectedPreferencesRevision: 0, expectedIdentityRevision: 0, idempotencyKey: "identity-generation-panel-001", acceptedPolicyIdentity: "a".repeat(64) };
const button = (label: string, within: Element = host) => [...within.querySelectorAll("button")].find(value => value.textContent?.trim() === label)!;
async function render() { await act(async () => root.render(<IdentityGeneration identity={identity} />)); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); start.mockReset(); refresh.mockReset(); retry.mockReset(); closeOriginal.mockReset(); stop.mockReset();
  Object.defineProperties(HTMLDialogElement.prototype, { showModal: { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } }, close: { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } } });
  const account = { status: "ready" as const, userId: ownerId, generation: 1 };
  const client = { current: () => true, generation: vi.fn(), batch: vi.fn(), batchRequest: vi.fn(), generate: vi.fn(), closeBatchRequest: vi.fn(), stopBatch: vi.fn() };
  const controller = createIdentityGenerationController({ account, projectId, client, memory: createIdentityDraftMemory(), canStart: () => true });
  vi.spyOn(controller, "start").mockImplementation(async input => { start(input); }); vi.spyOn(controller, "refresh").mockImplementation(async () => { refresh(); }); vi.spyOn(controller, "retryOriginal").mockImplementation(async () => { retry(); });
  vi.spyOn(controller, "closeOriginal").mockImplementation(async () => { closeOriginal(); });
  vi.spyOn(controller, "stop").mockImplementation(async () => { stop(); });
  identity = { verified: account, overview: fixtureOverview({ systems: [] }), generationBlockedReason: null,
    generation: { ...EMPTY_IDENTITY_GENERATION, controller, overview: { ownerId, projectId, latest: null, availability: { version: 2, spendControl: "uncapped", ownerId, projectId, status: "available", operation: "identity.image", requestedModel: IMAGE_MODEL,
      policyIdentity: "a".repeat(64), handlerVersion: "identity-image-v1", targetCount: 3, maxReferenceImages: 4, maxReferenceBytes: 20_971_520 } } } };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close"); });
it("requires an explicit review and confirmation, retains four saved revisions and never sends a monetary cap", async () => {
  await render(); expect(start).not.toHaveBeenCalled(); await act(async () => button("Review Identity generation").click());
  const dialog = host.querySelector("dialog[open]")!; expect(dialog.textContent).toContain("Font names are specifications"); expect(start).not.toHaveBeenCalled();
  await act(async () => button("Start Identity generation", dialog).click());
  expect(start).toHaveBeenCalledOnce(); expect(start.mock.calls[0]![0]).toMatchObject({ ...intent, idempotencyKey: expect.any(String) }); expect(start.mock.calls[0]![0]).not.toHaveProperty("acceptedMaxCostMicrousd");
});
it.each(["project", "references", "preferences", "selection", "policy", "owner"])("invalidates the open confirmation when %s changes", async change => {
  await render(); await act(async () => button("Review Identity generation").click());
  const overview = identity.overview!;
  if (change === "project") identity = { ...identity, overview: { ...overview, project: { ...overview.project, current_revision: 2 } } };
  if (change === "references") identity = { ...identity, overview: { ...overview, referenceSnapshot: { ...overview.referenceSnapshot, referenceRevision: 2 } } };
  if (change === "preferences") identity = { ...identity, overview: { ...overview, preferences: { ownerId, projectId, revision: 1, preferences: initialIdentityPreferences(overview.project.context), createdAt: "2026-10-27T00:00:00Z" } } };
  if (change === "selection") identity = { ...identity, overview: { ...overview, session: { ownerId, projectId, identityRevision: 1, currentSelectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", currentPreferencesRevision: 0, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z" } } };
  if (change === "policy") { const availability = identity.generation.overview!.availability; if (availability.status !== "available") throw new Error("fixture"); identity = { ...identity, generation: { ...identity.generation, overview: { ...identity.generation.overview!, availability: { ...availability, policyIdentity: "b".repeat(64) } } } }; }
  if (change === "owner") identity = { ...identity, verified: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 2 } };
  await render(); const dialog = host.querySelector("dialog[open]"); if (dialog) { expect(button("Start Identity generation", dialog).disabled).toBe(true); await act(async () => button("Start Identity generation", dialog).click()); }
  expect(start).not.toHaveBeenCalled();
});
it("retains an unknown request, exposes read-only Check and offers only same-key retry after explicit not-found", async () => {
  identity = { ...identity, generation: { ...identity.generation, retained: { ownerId, projectId, input: intent } } }; await render();
  expect(button("Review Identity generation").disabled).toBe(true); expect(button("Retry original generation")).toBeUndefined();
  await act(async () => button("Check original generation").click()); expect(refresh).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
  await act(async () => button("Stop original generation").click()); expect(closeOriginal).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
  identity = { ...identity, generation: { ...identity.generation, lookup: "not_found" } }; await render(); await act(async () => button("Retry original generation").click()); expect(retry).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
});

it("offers Stop for an admitted uncertain batch and distinguishes its acknowledgment from terminal cancellation", async () => {
  const batch = identityBatchStateSchema.parse({ ownerId, projectId, batchId: fixtureId(950), jobId: fixtureId(951), status: "needs_reconciliation", terminal: false, intent, input: fixtureInput(), systems: [], fulfillment: { targetCount: 3, acceptedCount: 0, status: "none" } });
  identity = { ...identity, generation: { ...identity.generation, batch } }; await render();
  expect(button("Review Identity generation").disabled).toBe(true); expect(host.textContent).toContain("Stop does not confirm that a remote provider has stopped.");
  await act(async () => button("Stop further work").click()); expect(stop).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
  identity = { ...identity, generation: { ...identity.generation, stopAcknowledgedBatchId: batch.batchId } }; await render();
  expect(button("Stop requested").disabled).toBe(true); expect(host.textContent).toContain("Existing provider outcomes still need verification"); expect(host.textContent).not.toContain("Generation stopped.");
  expect(button("Review Identity generation").disabled).toBe(true);
});
