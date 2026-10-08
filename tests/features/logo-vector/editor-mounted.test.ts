// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "../../../src/components/workspace/account-session";
import { LogoEditorWorkspace } from "../../../src/features/logo-vector/components/logo-editor-workspace";
import { createVectorHttpFixture, source } from "./http-fixture";
import { dispatchLogoComparisonLoads } from "./preview-events";

/** Mounted React with actual account/client/memory code, synthetic HTTP and
 * object URLs. This is not real-browser, raster decode or visual QA evidence. */
describe("mounted account vector editor", () => {
  let root: Root, host: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("crypto", webcrypto);
    URL.createObjectURL = vi.fn(() => `blob:synthetic-${Math.random()}`); URL.revokeObjectURL = vi.fn();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  async function until(test: () => boolean) { for (let i = 0; i < 80 && !test(); i++) await act(async () => { dispatchLogoComparisonLoads(host); await new Promise(resolve => setTimeout(resolve, 10)); }); expect(test(), host.textContent ?? "DOM state").toBe(true); }
  const button = (text: string) => [...host.querySelectorAll("button")].find(node => node.textContent === text) as HTMLButtonElement | undefined;
  const rotation = () => host.querySelector<HTMLInputElement>('input[aria-label="Component rotation"]');
  async function click(text: string) { await until(() => button(text)?.disabled === false); const target = button(text)!; await act(async () => target.click()); }
  async function changeRotation(value: string) {
    const input = rotation(); expect(input).not.toBeNull(); expect(input!.disabled).toBe(false); expect(input!.closest("fieldset")!.disabled).toBe(false);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input!.dispatchEvent(new Event("input", { bubbles: true })); input!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  }
  async function mount(change?: (fixture: ReturnType<typeof createVectorHttpFixture>) => void, expectInvalid = false) {
    const f = createVectorHttpFixture(); change?.(f); vi.stubGlobal("fetch", f.fetcher);
    function App() { const account = useAccountSession(); return createElement("div", null, createElement("button", { onClick: account.refresh }, "Recheck account"), createElement(LogoEditorWorkspace, { projectId: source.input.projectId })); }
    await act(async () => root.render(createElement(AccountSessionProvider, null, createElement(App))));
    await until(() => expectInvalid ? host.textContent!.includes("saved vector could not be verified") : !!host.querySelector('svg[aria-label="Vector candidate"]')); return f;
  }
  it("loads the preserved original and requires an explicit acceptance action", async () => {
    const f = await mount(); await until(() => !!host.querySelector('img[alt="Original concept"]'));
    expect(f.state.posts).toHaveLength(0); await click("Accept this vector"); await until(() => host.textContent!.includes("Approved logo"));
    expect(f.state.posts).toHaveLength(1); expect(f.state.posts[0]!.path).toBe(`/api/projects/${source.input.projectId}/logo/vector/accept`);
  });
  it("manual preview remains unsent until Save and a stored candidate stays unapproved", async () => {
    const f = await mount(); await changeRotation("15"); await until(() => host.textContent!.includes("Unsaved vector change"));
    expect(f.state.posts).toHaveLength(0); await click("Save edit"); await until(() => rotation()?.value === "15" && button("Save edit")?.disabled === true);
    expect(f.state.posts).toHaveLength(1); expect(f.state.workspace.approvedLogo).toBeNull();
  });
  it("lost save acknowledgement recovers the original receipt without a second POST", async () => {
    const f = await mount(); f.state.lose = true; await changeRotation("10"); await click("Save edit"); await until(() => button("Check original request")?.disabled === false);
    await click("Check original request"); await until(() => f.state.requestReads > 0 && rotation()?.value === "10" && !button("Check original request")); expect(f.state.posts).toHaveLength(1);
  });
  it("same-owner refresh restores the vector draft; another owner sees no prior geometry or preview", async () => {
    const f = await mount(); await changeRotation("12"); await click("Recheck account"); await until(() => rotation()?.value === "12"); expect(f.state.posts).toHaveLength(0);
    f.state.owner = "99999999-9999-4999-8999-999999999999"; await click("Recheck account"); await until(() => !host.querySelector("svg") && !host.querySelector('img[alt="Original concept"]'));
  });
  it("reviews a historical vector before explicitly restoring it as current", async () => {
    const f = await mount(); await changeRotation("8"); await click("Save edit"); await until(() => rotation()?.value === "8" && button("Review vector version 1")?.disabled === false);
    await click("Review vector version 1"); await until(() => button("Restore this version")?.disabled === false); expect(f.state.posts).toHaveLength(1);
    await click("Restore this version"); await until(() => rotation()?.value === "0" && f.state.posts.length === 2);
    expect(f.state.posts[1]!.path).toBe(`/api/projects/${source.input.projectId}/logo/restore`);
  });
  it.each(["paint", "path", "proof"] as const)("shows no preview or acceptance action for tampered %s", async change => {
    const f = await mount(fixture => {
      if (change === "paint") fixture.initial.document.components[0]!.paths[0]!.fill!.color = "#123456";
      if (change === "path") fixture.initial.document.components[0]!.paths[0]!.d = "M 22 40 L 40 20 L 60 40 L 40 60 Z";
      if (change === "proof") fixture.initial.revision.proof.svgContentHash = fixture.initial.revision.svgAsset.contentHash = "b".repeat(64);
    }, true);
    expect(host.querySelector("svg")).toBeNull(); expect(host.querySelector('img[alt="Original concept"]')).toBeNull();
    expect(button("Accept this vector")?.disabled ?? true).toBe(true); expect(f.state.posts).toHaveLength(0);
  });
  it("keyboard focus changes and equivalent numeric Enter leave every control available", async () => {
    const f = await mount(), scale = host.querySelector<HTMLInputElement>('input[aria-label="Component scale"]')!;
    await act(async () => { scale.focus(); rotation()!.focus(); });
    expect(rotation()!.closest("fieldset")!.disabled).toBe(false); expect(host.textContent).not.toContain("Unsaved vector change");
    await act(async () => {
      scale.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(scale, "1.0");
      scale.dispatchEvent(new Event("input", { bubbles: true })); scale.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    for (const label of ["Component rotation", "Component X position", "Component Y position"]) {
      const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      await act(async () => { input.focus(); input.blur(); }); expect(input.closest("fieldset")!.disabled).toBe(false);
    }
    expect(host.textContent).not.toContain("Unsaved vector change"); expect(f.state.posts).toHaveLength(0);
    await changeRotation("5"); await until(() => host.textContent!.includes("Unsaved vector change")); expect(f.state.posts).toHaveLength(0);
  });
});
