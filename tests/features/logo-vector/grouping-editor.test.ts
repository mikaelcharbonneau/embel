// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { AccountSessionProvider, useAccountSession } from "../../../src/components/workspace/account-session";
import { LogoEditorWorkspace } from "../../../src/features/logo-vector/components/logo-editor-workspace";
import { canonicalLogoDocumentBytes } from "../../../src/features/logo-vector/model/canonical";
import { flattenLogoPaths } from "../../../src/features/logo-vector/model/geometry";
import { captureLogoComponentLocks } from "../../../src/features/logo-vector/model/locks";
import { serializeLogoSvg } from "../../../src/features/logo-vector/model/svg";
import { createVectorHttpFixture, source } from "./http-fixture";
import { dispatchLogoComparisonLoads } from "./preview-events";

/** Actual account/editor/client/recovery, synthetic HTTP only; no provider or live storage evidence. */
describe("whole-path grouping in the account editor", () => {
  let root: Root, host: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto);
    let ordinal = 0; URL.createObjectURL = vi.fn(() => `blob:synthetic-grouping-${++ordinal}`); URL.revokeObjectURL = vi.fn();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const button = (name: string) => [...host.querySelectorAll("button")].find(item => item.textContent === name);
  async function until(test: () => boolean) { for (let i = 0; i < 80 && !test(); i++) await act(async () => { dispatchLogoComparisonLoads(host); await new Promise(resolve => setTimeout(resolve, 10)); }); expect(test(), host.textContent ?? "DOM state").toBe(true); }
  async function click(name: string) { await until(() => button(name)?.disabled === false); const target = button(name); expect(target, name).toBeDefined(); expect(target!.disabled, name).toBe(false); await act(async () => target!.click()); }
  async function field(label: string, value: string) {
    const target = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
    await act(async () => { Object.getOwnPropertyDescriptor(target.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(target, value); target.dispatchEvent(new Event(target.tagName === "SELECT" ? "change" : "input", { bubbles: true })); });
  }
  async function addRegions() {
    await click("Group whole paths");
    for (const region of [{ id: "user-symbol", role: "symbol", bounds: [18, 18, 44, 44] }, { id: "user-lettering", role: "lettering", bounds: [80, 25, 70, 40] }]) {
      await field("Region ID", region.id); await field("Region role", region.role);
      for (const [index, label] of ["X", "Y", "width", "height"].entries()) await field(`Region ${label}`, String(region.bounds[index]));
      await click("Add region");
    }
    await click("Preview grouping");
  }
  async function mount(change: (f: ReturnType<typeof createVectorHttpFixture>) => void = () => {}) {
    const fixture = createVectorHttpFixture(), old = fixture.initial.document;
    fixture.initial.document = { ...old, components: [{ ...old.components[0]!, id: "synthetic-whole-artwork", role: "whole_artwork", paths: old.components.flatMap(component => component.paths) }] };
    const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    fixture.initial.revision.documentHash = fixture.initial.revision.documentAsset.contentHash = fixture.initial.revision.proof.documentHash = hash(canonicalLogoDocumentBytes(fixture.initial.document));
    fixture.initial.revision.svgAsset.contentHash = fixture.initial.revision.proof.svgContentHash = hash(serializeLogoSvg(fixture.initial.document));
    fixture.initial.revision.proof.componentCount = 1;
    change(fixture); vi.stubGlobal("fetch", fixture.fetcher);
    function App() { const account = useAccountSession(); return createElement("div", null, createElement("button", { onClick: account.refresh }, "Recheck account"), createElement(LogoEditorWorkspace, { projectId: source.input.projectId })); }
    await act(async () => root.render(createElement(AccountSessionProvider, null, createElement(App))));
    await until(() => !!host.querySelector('svg[aria-label="Vector candidate"]')); return fixture;
  }
  it("groups a traced whole artwork through the existing explicit-save candidate flow", async () => {
    const f = await mount(), before = flattenLogoPaths(f.initial.document), originalId = f.initial.revision.id;
    await addRegions(); expect(f.state.posts).toHaveLength(0); await click("Apply grouping");
    await until(() => host.textContent!.includes("Unsaved vector change")); expect(f.state.posts).toHaveLength(0);
    await until(() => host.querySelector('nav[aria-label="Saved logo components"]')?.textContent?.includes("lettering") === true);
    const components = host.querySelector('nav[aria-label="Saved logo components"]')!;
    expect(components.textContent).toContain("symbol"); expect(components.textContent).toContain("lettering");
    expect(button("Group whole paths")?.disabled ?? button("Preview grouping")?.disabled).toBe(true); await click("Save edit");
    await until(() => f.state.currentVectorId !== originalId && !host.textContent!.includes("Unsaved vector change") && !!host.querySelector('img[alt="Original concept"]'));
    expect(f.state.posts).toHaveLength(1); expect(f.state.posts[0]!.path).toMatch(/\/logo\/edits$/);
    expect(f.state.posts[0]!.body).toMatchObject({ baseVectorRevisionId: originalId, edit: { kind: "group_components", regions: [{ id: "user-symbol" }, { id: "user-lettering" }] } });
    const saved = f.details.get(f.state.currentVectorId)!;
    expect(flattenLogoPaths(saved.document)).toEqual(before); expect(saved.document.components[1]!.editingKind).toBe("outlined_custom");
    expect(saved.document.components[1]).not.toHaveProperty("textSource"); expect(f.state.workspace.approvedLogo).toBeNull();
    expect(host.querySelector('img[alt="Original concept"]')).not.toBeNull();
  });
  it("does not offer usable grouping when the actual saved artwork is locked or saving unavailable", async () => {
    await mount(f => { f.initial.revision.locks = [...captureLogoComponentLocks(f.initial.document, ["synthetic-whole-artwork"])]; });
    expect(button("Group whole paths")?.disabled).toBe(true); expect(host.querySelector('[aria-label="Region ID"]')).toBeNull();
  });
  it("blocks grouping while save capability is unavailable", async () => {
    await mount(f => { f.state.workspace.capabilities.save = { status: "unavailable", reason: "synthetic unavailable" }; });
    expect(button("Group whole paths")?.disabled).toBe(true); expect(host.querySelector('[aria-label="Region ID"]')).toBeNull();
  });
  it("keeps the same grouping request after lost acknowledgement and clears former-owner selection UI", async () => {
    const f = await mount(); await addRegions(); await click("Apply grouping"); f.state.lose = true; await click("Save edit");
    await until(() => button("Check original request")?.disabled === false); expect(button("Group whole paths")?.disabled ?? button("Preview grouping")?.disabled).toBe(true);
    await click("Check original request"); await until(() => !button("Check original request") && f.state.requestReads > 0); expect(f.state.posts).toHaveLength(1);
    await click("Group whole paths"); await field("Region ID", "private-draft-name");
    const previewUrl = host.querySelector('svg[aria-label="Grouping selection preview"] > image')?.getAttribute("href");
    expect(previewUrl).toMatch(/^blob:synthetic-grouping-/);
    f.state.owner = "99999999-9999-4999-8999-999999999999"; await click("Recheck account");
    await until(() => !host.querySelector("svg")); expect(host.textContent).not.toContain("private-draft-name"); expect(host.querySelector('[aria-label="Region ID"]')).toBeNull();
    expect(host.querySelector("image")).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledWith(previewUrl);
  });
});
