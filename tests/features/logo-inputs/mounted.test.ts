// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { File as NodeFile } from "node:buffer";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogoInputsPanel } from "@/features/logo-inputs/components/logo-inputs-panel";
import { createLogoInputSession } from "@/features/logo-inputs/client/session";
import type { LogoInputClient } from "@/features/logo-inputs/client/controller";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { LogoReferenceRegistration } from "@/domain/logo-workspace";
import { syntheticLogoWorkspace, logoFixtureId as id } from "../../fixtures/logo-creation";
describe("mounted retained input panel", () => {
  let root: Root, host: HTMLDivElement;
  beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("File", NodeFile); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
  function button(name: string) { return [...host.querySelectorAll("button")].find(node => node.textContent === name)!; }
  async function click(name: string) { expect(button(name)?.disabled).toBe(false); await act(async () => button(name).click()); await settle(); }
  function fixture() {
    const base = syntheticLogoWorkspace(), workspace = { ...base, capabilities: { ...base.capabilities, upload: { status: "available" as const } } };
    const account = { status: "ready", userId: workspace.ownerId, generation: 2 } as VerifiedAccount;
    const session = createLogoInputSession(); session.bind(account);
    let lose = true, releases = 0; const requests: { requestKey: string; file: File }[] = [], references: LogoReferenceRegistration[] = [];
    const client: LogoInputClient = {
      listLogoReferences: async () => ({ ownerId: workspace.ownerId, projectId: workspace.projectId, items: references, nextCursor: null }), listLogoFonts: async () => [], listCatalogLogoFonts: async () => [],
      listLogoInputRequests: async () => ({ ownerId: workspace.ownerId, projectId: workspace.projectId, items: [], nextCursor: null }), readLogoInputRequest: async () => ({ status: "not_found" }), cancelLogoInputRequest: async () => null,
      async uploadLogoReference(input) { requests.push(input); if (lose) throw Error("Lost connection before arrival"); const ref: LogoReferenceRegistration = { referenceId: id(61), asset: { ownerId: workspace.ownerId, projectId: workspace.projectId, assetId: id(62), versionId: id(63), contentHash: createHash("sha256").update(new Uint8Array(await input.file.arrayBuffer())).digest("hex") }, sourceKind: "upload", rightsEvidenceId: id(64), aspects: input.aspects, workspace }; references.push(ref); return ref; },
      uploadLogoFont: async () => null, importCatalogLogoFont: async () => null, previewLogoReference: async () => ({ url: "blob:owned-fixture", release() { releases++; } }),
    };
    const props = { client, workspace, bindingKey: `${account.userId}:${account.generation}`, isCurrent: () => session.isCurrent(account), canWrite: true, session, account, mode: "references" as const, selections: [], onSelectionsChange: () => undefined };
    return { props, session, account, workspace, requests, client, allow: () => { lose = false; }, releases: () => releases };
  }
  it("requires a new permission declaration after the selected file changes", async () => {
    const f = fixture(); await act(async () => root.render(createElement(LogoInputsPanel, f.props))); await settle();
    const choose = async (name: string) => { const input = host.querySelector<HTMLInputElement>('input[type="file"]')!; await act(async () => { Object.defineProperty(input, "files", { configurable: true, value: [new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" })] }); input.dispatchEvent(new Event("change", { bubbles: true })); }); };
    await choose("first.png");
    const permission = [...host.querySelectorAll("label")].find(label => label.textContent === "I have permission to use and process this image.")!.querySelector<HTMLInputElement>("input")!;
    await act(async () => permission.click()); expect(permission.checked).toBe(true);
    await choose("second.png"); expect(permission.checked).toBe(false); expect(button("Upload reference").disabled).toBe(true); expect(f.requests).toEqual([]);
  });
  it("preserves request and original file through Strict Mode navigation, then clears only the confirmed form", async () => {
    const f = fixture();
    await act(async () => root.render(createElement(StrictMode, null, createElement(LogoInputsPanel, f.props)))); await settle();
    const file = new File([new Uint8Array([1, 2, 3])], "retained.png", { type: "image/png" });
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => { Object.defineProperty(input, "files", { configurable: true, value: [file] }); input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(f.session.hasUnsaved()).toBe(true);
    const shape = [...host.querySelectorAll("label")].find(label => label.textContent === "Shape")!.querySelector<HTMLInputElement>("input")!;
    const permission = [...host.querySelectorAll("label")].find(label => label.textContent === "I have permission to use and process this image.")!.querySelector<HTMLInputElement>("input")!;
    await act(async () => { shape.click(); permission.click(); }); await click("Upload reference");
    expect(f.requests).toHaveLength(1); const key = f.requests[0]!.requestKey;
    await act(async () => root.render(createElement("p", null, "Another page")));
    expect(f.session.hasUnsaved()).toBe(true);
    await act(async () => root.render(createElement(StrictMode, null, createElement(LogoInputsPanel, { ...f.props, client: { ...f.client } })))); await settle();
    expect(host.textContent).toContain("retained.png"); expect(host.textContent).toContain(key); expect(f.requests).toHaveLength(1);
    await click("Check original input"); f.allow(); await click("Retry unchanged input");
    expect(f.requests).toHaveLength(2); expect(f.requests[1]!.requestKey).toBe(key); expect(f.requests[1]!.file).toBe(file);
    expect(f.session.hasUnsaved()).toBe(false); expect(host.textContent).toContain("Reference saved.");
    await act(async () => root.render(createElement("p", null, "Another page"))); expect(f.releases()).toBeGreaterThan(0);
  });
});
