// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogoVectorConversionControls, LogoVectorSettingsSummary } from "@/components/logo-creation/vector-conversion-controls";
import { captureLogoVectorReviewContext, createLogoVectorReviewRequest, type LogoVectorReviewContext } from "@/components/logo-creation/vector-conversion-request";
import { createLogoCreationController } from "@/components/logo-creation/creation-controller";
import { createAccountLogoClient } from "@/components/identity/account-logo-client";
import { LogoCostConfirmation } from "@/components/logo-creation/cost-confirmation";
import type { LogoGenerationIntent, LogoQuoteRequest, LogoRequestState } from "@/domain/logo-jobs";
import { syntheticLogoQuote, syntheticLogoWorkspace, logoFixtureId as id } from "../fixtures/logo-creation";

const settings = { preset: "bw" as const, simplify: 0, filterSpeckle: 0, maxColors: 2 };
function context(): LogoVectorReviewContext {
  const workspace = syntheticLogoWorkspace();
  return { ownerId: workspace.ownerId, projectId: workspace.projectId, generation: 1, expected: workspace.heads,
    source: { kind: "concept", batchId: id(60), slotId: id(110), attemptId: id(120) } };
}

describe("bounded vector conversion review request", () => {
  it("captures independent immutable view context and rejects malformed local bindings", () => {
    const original = context(), captured = captureLogoVectorReviewContext(original)!;
    expect(captured).toEqual(original); expect(captured).not.toBe(original);
    expect(Object.isFrozen(captured.expected)).toBe(true); expect(Object.isFrozen(original)).toBe(false);
    expect(captureLogoVectorReviewContext({ ...original, ownerId: "not-an-owner" })).toBeNull();
    expect(captureLogoVectorReviewContext({ ...original, generation: -1 })).toBeNull();
    expect(captureLogoVectorReviewContext({ ...original, source: { kind: "refinement", rasterRevisionId: "bad" } })).toBeNull();
    expect(createLogoVectorReviewRequest({ ...original, source: null }, original, settings)).toBeNull();
  });
  it("freezes the exact source, heads and settings without mutating the caller", () => {
    const original = context(), chosen = { ...settings, preset: "poster" as const, maxColors: 12, simplify: 1.25, filterSpeckle: 4 };
    const request = createLogoVectorReviewRequest(original, original, chosen);
    expect(request).toEqual({ operation: "vectorize", expected: original.expected, source: original.source, settings: chosen });
    expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request!.settings)).toBe(true);
    expect(Object.isFrozen(request!.expected.stageRevisions)).toBe(true); expect(Object.isFrozen(request!.source)).toBe(true);
    expect(Object.isFrozen(chosen)).toBe(false); chosen.simplify = 2;
    expect(request!.settings.simplify).toBe(1.25);
  });
  it.each([
    { simplify: -0.1 }, { simplify: 2.51 }, { simplify: NaN }, { simplify: Infinity },
    { filterSpeckle: -1 }, { filterSpeckle: 17 }, { filterSpeckle: 1.5 },
    { maxColors: 1 }, { maxColors: 33 }, { maxColors: 2.5 }, { maxColors: 3 }, { preset: "unsupported" },
  ])("rejects invalid settings rather than silently correcting %j", change => {
    const current = context(); expect(createLogoVectorReviewRequest(current, current, { ...settings, ...change })).toBeNull();
  });
  it.each([
    null,
    { ownerId: id(999) }, { projectId: id(999) }, { generation: 2 },
    { source: { kind: "refinement", rasterRevisionId: id(173) } },
    { expected: { ...syntheticLogoWorkspace().heads, workspaceRevision: 1 } },
  ])("rejects a stale owner, session, project, selection or saved revision: %j", change => {
    const captured = context(), current = change ? { ...captured, ...change } as LogoVectorReviewContext : null;
    expect(createLogoVectorReviewRequest(captured, current, settings)).toBeNull();
  });
  it("accepts supported endpoints and an exact selected refinement without inventing a concept source", () => {
    const current = { ...context(), source: { kind: "refinement" as const, rasterRevisionId: id(173) } };
    for (const limits of [{ simplify: 0, filterSpeckle: 0, maxColors: 2 }, { simplify: 2.5, filterSpeckle: 16, maxColors: 32 }]) {
      expect(createLogoVectorReviewRequest(current, current, { preset: "poster", ...limits })).toMatchObject({ source: current.source, settings: limits });
    }
  });
});

let root: Root | null = null, dispose: (() => void) | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; dispose?.(); dispose = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); });
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  const captured = context(), base = syntheticLogoWorkspace();
  const approval = { id: id(170), ownerId: base.ownerId, projectId: base.projectId, vectorRevisionId: id(171), stageRevisionId: id(172), approvedAt: "2026-10-07T00:00:00Z" };
  let current: LogoVectorReviewContext | null = captured, available = true, blocked = false, quoteStatus = 200;
  let quoteGate: Promise<void> | null = null;
  let workspace = { ...base, approvedLogo: approval }, pending: LogoGenerationIntent | null = null;
  let requestState: LogoRequestState = { status: "not_found" };
  const quotes: LogoQuoteRequest[] = [], admissions: LogoGenerationIntent[] = [], paths: string[] = [];
  const account = { status: "ready" as const, userId: base.ownerId, generation: 1 };
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url); paths.push(path);
    if (path.endsWith("/quotes")) {
      const request = JSON.parse(String(init?.body)) as LogoQuoteRequest; quotes.push(request);
      if (quoteGate) await quoteGate;
      return Response.json({ ...syntheticLogoQuote(), id: id(150 + quotes.length), request, expected: request.expected, conceptPlan: null, targetSlotIds: [],
        provider: null, model: null, engine: { id: "synthetic-vector", version: "1.0", artifactHash: "a".repeat(64), settingsHash: "b".repeat(64) },
        externalProviderCostMicrousd: 0, estimatedCostMicrousd: 0, maxCostMicrousd: 0, expiresAt: new Date(Date.now() + 60_000).toISOString() }, { status: quoteStatus });
    }
    if (path.endsWith("/requests")) {
      const body = JSON.parse(String(init?.body)) as LogoGenerationIntent; admissions.push(body);
      return Response.json({ ownerId: base.ownerId, projectId: base.projectId, requestKey: body.requestKey, operation: "identity.logo_vectorize", batchId: null, jobIds: [id(500)], inputHash: "b".repeat(64) });
    }
    return Response.json(requestState);
  };
  const client = createAccountLogoClient(account, base.projectId, () => !!current, () => { current = null; }, fetcher);
  const controller = createLogoCreationController({ client, projectId: base.projectId, getWorkspace: () => workspace, hasUnsavedInputs: () => blocked,
    getPendingIntent: () => pending, retainIntent: value => { pending = value; }, clearIntent: key => { if (pending?.requestKey === key) pending = null; },
    isOperationAvailable: () => available, isCurrent: () => !!current, now: Date.now, createRequestKey: () => id(600 + admissions.length), refreshWorkspace: async () => "reloaded" });
  dispose = controller.dispose;
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  async function render() { await act(async () => root!.render(createElement("div", null,
    createElement(LogoVectorConversionControls, { context: captured, getCurrentContext: () => current, controller, available, blocked }),
    createElement(LogoCostConfirmation, { controller })))); }
  await render();
  const button = (text: string) => [...container.querySelectorAll("button")].find(node => node.textContent === text)!;
  async function change(label: string, value: string) {
    const input = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
    await act(async () => {
      const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    });
  }
  return { container, controller, quotes, admissions, paths, button, change, render, approval,
    get workspace() { return workspace; }, get pending() { return pending; },
    setCurrent(value: LogoVectorReviewContext | null) { current = value; }, setAvailable(value: boolean) { available = value; },
    setBlocked(value: boolean) { blocked = value; }, setQuoteStatus(value: number) { quoteStatus = value; },
    setRequestState(value: LogoRequestState) { requestState = value; },
    holdQuote() { let release!: () => void; quoteGate = new Promise<void>(resolve => { release = resolve; }); return release; },
    changeHeads() { workspace = { ...workspace, heads: { ...workspace.heads, workspaceRevision: 1 } }; },
  };
}
async function until(check: () => void) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { check(); return; } catch (error) { if (attempt === 99) throw error; }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
  }
}
describe("vector settings controls", () => {
  it("prepares a delayed estimate without taking focus or starting conversion", async () => {
    const f = await mount(), release = f.holdQuote();
    const input = f.container.querySelector<HTMLInputElement>('[aria-label="Simplification"]')!;
    input.focus();
    await until(() => expect(f.quotes).toHaveLength(1));
    expect(f.button("Convert to vector").disabled).toBe(true);
    expect(f.admissions).toEqual([]);
    await act(async () => release());
    await until(() => expect(f.button("Convert to vector").disabled).toBe(false));
    expect(document.activeElement).toBe(input); expect(f.container.querySelector("dialog")).toBeNull();
    expect(f.pending).toBeNull();
  });
  it("shows the expected cost before one click and never converts on mount or edit", async () => {
    const f = await mount();
    await f.change("Simplification", "1.25"); await f.change("Speckle filtering", "4");
    await f.change("Conversion color mode", "poster"); await f.change("Maximum colors", "12");
    await until(() => expect(f.button("Convert to vector").disabled).toBe(false));
    expect(f.quotes).toEqual([{ operation: "vectorize", expected: context().expected, source: context().source, settings: { preset: "poster", simplify: 1.25, filterSpeckle: 4, maxColors: 12 } }]);
    expect(f.container.textContent).toContain("Expected cost: $0.00"); expect(f.admissions).toEqual([]);
    await act(async () => { f.button("Convert to vector").click(); f.button("Convert to vector").click(); });
    expect(f.admissions).toHaveLength(1); expect(f.pending).toEqual(f.admissions[0]);
    expect(f.workspace.approvedLogo).toEqual(f.approval);
  });
  it.each([["Simplification", ""], ["Simplification", "2.6"], ["Speckle filtering", "1.5"], ["Speckle filtering", "17"]])("keeps invalid %s input visible and blocks quotes and conversion", async (label, value) => {
    const f = await mount(); await f.change(label, value);
    expect(f.button("Convert to vector").disabled).toBe(true);
    expect(f.container.querySelector("[role=alert]")?.textContent).toContain("Enter simplification");
    await act(async () => { f.button("Convert to vector").click(); await new Promise(resolve => setTimeout(resolve, 400)); });
    expect(f.paths).toEqual([]); expect(f.admissions).toEqual([]);
  });
  it("requires whole bounded poster colors and returns to two colors for black and white", async () => {
    const f = await mount(); const colors = f.container.querySelector<HTMLInputElement>('[aria-label="Maximum colors"]')!;
    expect(colors.disabled).toBe(true); expect(colors.value).toBe("2");
    await f.change("Conversion color mode", "poster"); expect(colors.disabled).toBe(false);
    await f.change("Maximum colors", "33"); expect(f.button("Convert to vector").disabled).toBe(true);
    await f.change("Maximum colors", "2.5"); expect(f.button("Convert to vector").disabled).toBe(true);
    await f.change("Maximum colors", "32"); await until(() => expect(f.button("Convert to vector").disabled).toBe(false));
    await f.change("Conversion color mode", "bw"); expect(colors.disabled).toBe(true); expect(colors.value).toBe("2");
    expect(f.button("Convert to vector").disabled).toBe(true);
    await until(() => expect(f.button("Convert to vector").disabled).toBe(false));
    expect(f.quotes.at(-1)).toMatchObject({ settings: { preset: "bw", maxColors: 2 } }); expect(f.admissions).toEqual([]);
  });
  it("refreshes changed settings without changing the earlier quote or starting work", async () => {
    const f = await mount(); await until(() => expect(f.button("Convert to vector").disabled).toBe(false));
    const original = structuredClone(f.quotes[0]);
    await f.change("Simplification", "2"); expect(f.button("Convert to vector").disabled).toBe(true);
    await until(() => expect(f.quotes).toHaveLength(2));
    expect(f.quotes[0]).toEqual(original); expect(f.quotes[1]).toMatchObject({ settings: { simplify: 2 } });
    expect(f.admissions).toEqual([]); expect(f.pending).toBeNull();
  });
  it("fences a selection change before a stale rendered click", async () => {
    const f = await mount(); await until(() => expect(f.button("Convert to vector").disabled).toBe(false));
    f.setCurrent({ ...context(), source: { kind: "refinement", rasterRevisionId: id(173) } });
    await act(async () => f.button("Convert to vector").click());
    expect(f.admissions).toEqual([]); expect(f.container.textContent).toContain("saved selection or account changed");
  });
  it("fences account expiration and changed saved revisions at the deliberate click", async () => {
    const f = await mount(); await until(() => expect(f.button("Convert to vector").disabled).toBe(false));
    f.setCurrent(null); await act(async () => f.button("Convert to vector").click()); expect(f.admissions).toEqual([]);
    f.setCurrent(context()); await f.render();
    f.changeHeads(); await act(async () => f.button("Convert to vector").click());
    expect(f.admissions).toEqual([]); expect(f.workspace.approvedLogo).toEqual(f.approval);
  });
  it("blocks unavailable or unsaved inputs and offers an explicit retry after a failed estimate", async () => {
    const f = await mount(); f.setAvailable(false); await f.render(); expect(f.button("Convert to vector").disabled).toBe(true);
    f.setAvailable(true); f.setBlocked(true); await f.render(); expect(f.button("Convert to vector").disabled).toBe(true);
    expect(f.paths).toEqual([]); f.setBlocked(false); f.setQuoteStatus(503); await f.render();
    await until(() => expect(f.button("Refresh estimate")).toBeDefined());
    expect(f.quotes).toHaveLength(1); expect(f.admissions).toEqual([]);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); }); expect(f.quotes).toHaveLength(1);
    f.setQuoteStatus(200); await act(async () => f.button("Refresh estimate").click());
    await until(() => expect(f.button("Convert to vector").disabled).toBe(false));
    expect(f.quotes).toHaveLength(2); expect(f.admissions).toEqual([]);
  });
  it("keeps an unresolved conversion blocked and checks the original request without another quote", async () => {
    const f = await mount(); await until(() => expect(f.button("Convert to vector").disabled).toBe(false));
    await act(async () => f.button("Convert to vector").click());
    const original = f.pending!; f.setRequestState({ status: "not_found" });
    await act(async () => f.controller.checkRequest()); expect(f.button("Convert to vector").disabled).toBe(true);
    await act(async () => f.button("Convert to vector").click()); expect(f.quotes).toHaveLength(1); expect(f.pending).toEqual(original);
    expect(f.admissions).toHaveLength(1); expect(f.workspace.approvedLogo).toEqual(f.approval);
  });
  it("describes the exact immutable conversion settings", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(createElement(LogoVectorSettingsSummary, { settings: { preset: "poster", simplify: 2.5, filterSpeckle: 16, maxColors: 32 } })));
    expect(container.textContent).toBe("Poster color · Maximum colors 32 · Simplification 2.5 · Speckle filtering 16");
  });
});
