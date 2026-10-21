// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "../../../src/components/workspace/account-session";
import { LogoEditorWorkspace } from "../../../src/features/logo-vector/components/logo-editor-workspace";
import { canonicalLogoDocumentBytes } from "../../../src/features/logo-vector/model/canonical";
import { serializeLogoSvg } from "../../../src/features/logo-vector/model/svg";
import { createVectorHttpFixture, source } from "./http-fixture";

/** Real account/client/draft/editor flow with synthetic HTTP and DOM image
 * events. No browser decoder, provider, hosted service or visual QA claim. */
describe("account editor comparison readiness", () => {
  let root: Root, host: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto);
    let ordinal = 0; URL.createObjectURL = vi.fn(() => `blob:comparison-${++ordinal}`); URL.revokeObjectURL = vi.fn();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const vector = () => host.querySelector('svg[aria-label="Vector candidate"] > image')!;
  const original = () => host.querySelector('img[alt="Original concept"]')!;
  const button = (name: string) => [...host.querySelectorAll("button")].find(item => item.textContent === name);
  async function until(test: () => boolean) { for (let i = 0; i < 100 && !test(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); expect(test(), host.textContent ?? "DOM state").toBe(true); }
  async function event(target: Element, type: "load" | "error") { expect(target).not.toBeNull(); await act(async () => target.dispatchEvent(new Event(type))); }
  async function click(name: string) { await until(() => button(name)?.disabled === false); await act(async () => button(name)!.click()); }
  async function loadComparison() { await until(() => Boolean(vector() && original())); await event(vector(), "load"); await event(original(), "load"); }
  async function mount(change?: (f: ReturnType<typeof createVectorHttpFixture>) => void) {
    const f = createVectorHttpFixture(); change?.(f); vi.stubGlobal("fetch", f.fetcher);
    function App() { const account = useAccountSession(); return createElement("div", null, createElement("button", { onClick: account.refresh }, "Recheck account"), createElement(LogoEditorWorkspace, { projectId: source.input.projectId })); }
    await act(async () => root.render(createElement(AccountSessionProvider, null, createElement(App))));
    await until(() => Boolean(host.querySelector('svg[aria-label="Vector candidate"]') && original())); return f;
  }
  async function rotate(value: string) {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Component rotation"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  }

  it("blocks acceptance until both exact previews have loaded and still requires an explicit click", async () => {
    const f = await mount();
    expect(button("Accept this vector")?.disabled).toBe(true);
    await event(vector(), "load"); expect(button("Accept this vector")?.disabled).toBe(true);
    await event(original(), "load"); expect(button("Accept this vector")?.disabled).toBe(false);
    expect(f.state.posts).toHaveLength(0); await click("Accept this vector");
    await until(() => host.textContent!.includes("Approved logo")); expect(f.state.posts).toHaveLength(1);
  });
  it("keeps the loaded exact preview stable while the selected component changes", async () => {
    await mount(); await loadComparison(); const image = vector(), originalImage = original(), count = vi.mocked(URL.createObjectURL).mock.calls.length;
    await click("lettering");
    expect(vector()).toBe(image); expect(original()).toBe(originalImage); expect(URL.createObjectURL).toHaveBeenCalledTimes(count);
    expect(button("Accept this vector")?.disabled).toBe(false);
  });
  it("resets Save for the exact edited document and never accepts old preview events", async () => {
    const f = await mount(); await loadComparison(); const previousVector = vector(), previousOriginal = original(), previousUrl = previousVector.getAttribute("href");
    await rotate("15"); await until(() => host.textContent!.includes("Unsaved vector change") && Boolean(button("Save edit") && vector() && original()));
    expect(button("Save edit")?.disabled).toBe(true); expect(button("Accept this vector")?.disabled).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(previousUrl);
    await event(previousVector, "load"); await event(previousOriginal, "load"); expect(button("Save edit")?.disabled).toBe(true);
    await event(original(), "load"); expect(button("Save edit")?.disabled).toBe(true);
    await event(vector(), "load"); expect(button("Save edit")?.disabled).toBe(false);
    const urlCount = vi.mocked(URL.createObjectURL).mock.calls.length;
    await event(vector(), "load"); expect(URL.createObjectURL).toHaveBeenCalledTimes(urlCount);
    expect(f.state.posts).toHaveLength(0); await click("Save edit");
    await until(() => f.state.posts.length === 1 && !host.textContent!.includes("Unsaved vector change"));
    expect(f.state.posts[0]!.body).toMatchObject({ edit: { kind: "rotation", degrees: 15 } });
  });
  it.each(["canonical", "original"] as const)("disables Accept and Save when the active %s image fails", async which => {
    const f = await mount(); await loadComparison();
    const failed = which === "canonical" ? vector() : original(); await event(failed, "error");
    expect(button("Accept this vector")?.disabled).toBe(true); expect(host.querySelector('[role="alert"]')?.textContent).toContain("unavailable");
    await event(failed, "load"); expect(button("Accept this vector")?.disabled).toBe(true);
    await rotate("6"); await loadComparison(); expect(button("Save edit")?.disabled).toBe(false);
    await event(which === "canonical" ? vector() : original(), "error");
    expect(button("Save edit")?.disabled).toBe(true); expect(f.state.posts).toHaveLength(0);
  });
  it("requires a fresh loaded comparison for historical restoration and fails closed on decode error", async () => {
    const f = await mount(); await loadComparison(); const oldVector = vector(), oldOriginal = original();
    await click("Review vector version 1"); await until(() => !!button("Restore this version") && !!vector());
    expect(button("Restore this version")?.disabled).toBe(true);
    await event(oldVector, "load"); await event(oldOriginal, "error"); expect(button("Restore this version")?.disabled).toBe(true);
    await loadComparison(); expect(button("Restore this version")?.disabled).toBe(false);
    await event(vector(), "error"); expect(button("Restore this version")?.disabled).toBe(true); expect(f.state.posts).toHaveLength(0);
  });
  it("discards former-generation readiness and releases both images when the account changes", async () => {
    const f = await mount(); await loadComparison(); const oldVector = vector(), oldOriginal = original();
    const oldVectorUrl = oldVector.getAttribute("href"), oldOriginalUrl = oldOriginal.getAttribute("src");
    await click("Recheck account"); await until(() => Boolean(vector() && vector() !== oldVector));
    expect(button("Accept this vector")?.disabled).toBe(true);
    await event(oldVector, "load"); await event(oldOriginal, "error"); expect(button("Accept this vector")?.disabled).toBe(true);
    await loadComparison(); expect(button("Accept this vector")?.disabled).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldVectorUrl); expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldOriginalUrl);
    const previous = vector(); f.state.owner = "99999999-9999-4999-8999-999999999999"; await click("Recheck account");
    await until(() => !vector() && !original()); await event(previous, "load");
    expect(button("Accept this vector")).toBeUndefined(); expect(host.textContent).not.toContain("Vector candidate"); expect(f.state.posts).toHaveLength(0);
  });
  it("keeps the complete account editor DOM bounded for a hash-verified 20000-path document", async () => {
    const f = await mount(fixture => {
      const document = fixture.initial.document; document.components.splice(1);
      document.components[0]!.paths = Array.from({ length: 20000 }, (_, index) => ({ ...document.components[0]!.paths[0]!, id: `detail-${index}` }));
      const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex"), revision = fixture.initial.revision;
      revision.documentHash = revision.documentAsset.contentHash = revision.proof.documentHash = hash(canonicalLogoDocumentBytes(document));
      revision.svgAsset.contentHash = revision.proof.svgContentHash = hash(serializeLogoSvg(document)); revision.proof.pathCount = 20000; revision.proof.componentCount = 1;
    });
    expect(host.querySelectorAll("*").length).toBeLessThan(180); expect(host.querySelectorAll("path")).toHaveLength(0);
    expect(button("Accept this vector")?.disabled).toBe(true); await loadComparison();
    expect(button("Accept this vector")?.disabled).toBe(false); expect(f.state.posts).toHaveLength(0);
    await click("Group whole paths");
    expect(host.querySelectorAll("*").length).toBeLessThan(260); expect(host.querySelectorAll("path")).toHaveLength(0);
    expect(host.querySelectorAll("svg > image")).toHaveLength(2);
  // Real hash/geometry validation of 20,000 paths is CPU-bound in cloud CI.
  // DOM-size and approval assertions above remain exact; no product deadline changes.
  }, 120000);
});
