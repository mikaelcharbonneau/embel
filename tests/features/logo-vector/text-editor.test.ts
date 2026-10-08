// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { AccountSessionProvider, useAccountSession } from "../../../src/components/workspace/account-session";
import { LogoEditorWorkspace } from "../../../src/features/logo-vector/components/logo-editor-workspace";
import { createTextVectorHttpFixture } from "./text-http-fixture";
import { source } from "./http-fixture";
import { dispatchLogoComparisonLoads } from "./preview-events";

describe("actual font-backed lettering through the account editor", () => {
  let root: Root, host: HTMLDivElement;
  beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto); URL.createObjectURL = vi.fn(() => "blob:synthetic-text-edit"); URL.revokeObjectURL = vi.fn(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const button = (name: string) => [...host.querySelectorAll("button")].find(item => item.textContent === name);
  async function until(test: () => boolean) { for (let n = 0; n < 100 && !test(); n++) await act(async () => { dispatchLogoComparisonLoads(host); await new Promise(resolve => setTimeout(resolve, 10)); }); expect(test(), host.textContent ?? "DOM").toBe(true); }
  async function click(name: string) { await until(() => button(name)?.disabled === false); await act(async () => button(name)!.click()); }
  async function field(label: string, value: string) {
    const target = host.querySelector<HTMLSelectElement | HTMLInputElement>(`[aria-label="${label}"]`)!;
    await act(async () => { Object.getOwnPropertyDescriptor(target.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(target, value); target.dispatchEvent(new Event(target.tagName === "SELECT" ? "change" : "input", { bubbles: true })); });
  }
  async function mount(change: (fixture: ReturnType<typeof createTextVectorHttpFixture>) => void = () => {}) {
    const f = createTextVectorHttpFixture(); change(f); vi.stubGlobal("fetch", f.fetcher);
    function App() { const session = useAccountSession(); return createElement("div", null, createElement("button", { onClick: session.refresh }, "Recheck account"), createElement(LogoEditorWorkspace, { projectId: source.input.projectId })); }
    await act(async () => root.render(createElement(AccountSessionProvider, null, createElement(App))));
    await click("lettering"); await until(() => Boolean(button("Replace outlined lettering"))); return f;
  }
  async function prepare(f: ReturnType<typeof createTextVectorHttpFixture>) {
    await click("Replace outlined lettering"); await field("Replacement font", f.input.font.record.id); await click("Prepare lettering replacement");
    await until(() => host.textContent!.includes("Unsaved vector change"));
  }
  it("keeps the current logo unchanged until server shaping returns a new review-required version", async () => {
    const f = await mount(f => { f.state.workspace.approvedLogo = { id: "00000000-0000-4000-8000-000000000990", ownerId: f.state.workspace.ownerId, projectId: f.state.workspace.projectId, vectorRevisionId: f.initial.revision.id, stageRevisionId: f.state.workspace.stages.vector!.id, approvedAt: "2026-10-07T00:00:00Z" }; }), initialId = f.initial.revision.id;
    const originalApproval = structuredClone(f.state.workspace.approvedLogo);
    await prepare(f); expect(f.state.posts).toHaveLength(0); expect(f.state.currentVectorId).toBe(initialId);
    expect(host.textContent).toContain("Pending lettering change"); await click("Save edit");
    await until(() => f.errors.length > 0 || f.state.currentVectorId !== initialId && !host.textContent!.includes("Unsaved vector change"));
    if (f.errors.length) throw f.errors[0];
    const saved = f.details.get(f.state.currentVectorId)!;
    expect(saved.document.components[1]).toMatchObject({ editingKind: "editable_text", textSource: { text: source.brief.payload.name, font: f.input.font.record.asset } });
    expect(saved.document.components[0]).toEqual(f.initial.document.components[0]); expect(f.initial.document.components[1]).not.toHaveProperty("textSource");
    expect(f.state.posts).toHaveLength(1); expect(f.state.workspace.approvedLogo).toEqual(originalApproval); await click("Accept this vector");
    await until(() => f.state.workspace.approvedLogo?.vectorRevisionId === saved.revision.id); expect(f.state.posts).toHaveLength(2);
  });
  it("retains the exact text request after lost acknowledgement and checks it without reshaping", async () => {
    const f = await mount(); await prepare(f); f.state.lose = true; await click("Save edit");
    await until(() => button("Check original request")?.disabled === false); const request = structuredClone(f.state.posts[0]!.body);
    await click("Check original request"); await until(() => !button("Check original request"));
    expect(f.state.posts).toHaveLength(1); expect(f.state.posts[0]!.body).toEqual(request); expect(f.state.workspace.approvedLogo).toBeNull();
  });
  it("hides all former-owner text controls and keeps no automatic write after account changes", async () => {
    const f = await mount(); await click("Replace outlined lettering"); f.state.owner = "99999999-9999-4999-8999-999999999999"; await click("Recheck account");
    await until(() => !host.querySelector('[aria-label="Text controls"]')); expect(f.state.posts).toHaveLength(0); expect(host.querySelector('[aria-label="Replacement font"]')).toBeNull();
  });
  it("keeps an unsupported lettering request until an explicit durable cancellation, preserving the draft", async () => {
    const f = await mount(); await prepare(f); f.controls.rejectEdit = true; await click("Save edit");
    await until(() => button("Check original request")?.disabled === false); expect(host.textContent).toContain("could not be shaped");
    await click("Check original request"); expect(button("Check original request")).toBeDefined(); expect(f.cancelPosts).toHaveLength(0);
    await click("Cancel original edit request"); await until(() => !button("Check original request"));
    expect(host.textContent).toContain("Your lettering draft is still here"); expect(host.textContent).toContain("Unsaved vector change");
    expect(f.cancelPosts).toEqual([{ method: "saveLogoEdit", body: f.state.posts[0]!.body }]); expect(f.state.currentVectorId).toBe(f.initial.revision.id);
    await click("Discard edit"); expect(f.state.posts).toHaveLength(1); expect(f.state.workspace.approvedLogo).toBeNull();
  });
  it("recovers a lost cancellation acknowledgement with a read and no repeated cancellation", async () => {
    const f = await mount(); await prepare(f); f.controls.rejectEdit = true; await click("Save edit");
    await until(() => button("Check original request")?.disabled === false); f.controls.loseCancellation = true; await click("Cancel original edit request");
    await until(() => button("Check original request")?.disabled === false); expect(host.textContent).toContain("Unsaved vector change");
    await click("Check original request"); await until(() => !button("Check original request")); expect(f.cancelPosts).toHaveLength(1); expect(f.state.posts).toHaveLength(1);
  });

  it("cannot bypass an unresolved conflicting edit through discard-and-reload", async () => {
    const f = await mount(); await prepare(f); f.state.conflict = true; await click("Save edit");
    await until(() => Boolean(button("Discard change and load latest"))); expect(button("Discard change and load latest")!.disabled).toBe(true);
    await click("Cancel original edit request"); await until(() => button("Discard change and load latest")?.disabled === false);
    expect(host.textContent).toContain("Unsaved vector change"); await click("Discard change and load latest");
    await until(() => !host.textContent!.includes("Unsaved vector change")); expect(f.state.posts).toHaveLength(1);
  });

});
