// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogoManualEdit } from "../../../src/domain/logo-vector";
import { TextControls } from "../../../src/features/logo-vector/components/text-controls";
import { separatedLogoDocument } from "./fixtures";
import type { FontRecord } from "../../../src/domain/logo-directions";
const font: FontRecord = { id: "00000000-0000-4000-8000-000000000008", asset: { ownerId: "00000000-0000-4000-8000-000000000001", projectId: "00000000-0000-4000-8000-000000000002", assetId: "00000000-0000-4000-8000-000000000009", versionId: "00000000-0000-4000-8000-000000000010", contentHash: "a".repeat(64) }, family: "Synthetic owned font", source: "user_upload", rights: { id: "00000000-0000-4000-8000-000000000011", fontContentHash: "a".repeat(64), sourceKind: "reviewed_license", sourceUrl: "https://example.com/synthetic-license", licenseTextHash: "b".repeat(64), commercialUse: "allowed", permissions: { render: "allowed", outline: "allowed", embed: "denied", modify: "denied", redistribute: "denied" }, reviewedAt: "2026-10-07T00:00:00Z" } };

describe("explicit real-text edit controls", () => {
  let root: Root, host: HTMLDivElement, edits: LogoManualEdit[];
  beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); edits = []; });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const button = (text: string) => [...host.querySelectorAll("button")].find(item => item.textContent === text)!;
  async function click(text: string) { await act(async () => button(text).click()); }
  async function change(label: string, value: string) {
    const field = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
    await act(async () => { Object.getOwnPropertyDescriptor(field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
  }
  async function render(options: Partial<Parameters<typeof TextControls>[0]> = {}) {
    await act(async () => root.render(createElement(TextControls, { document: separatedLogoDocument(), componentId: "synthetic-lettering", lockedComponentIds: [], fonts: [font], briefName: "A\u0301ster", logoType: "combination", onEdit: edit => edits.push(edit), ...options })));
  }
  it("shows no font picker for custom outlines until the explicit replacement action", async () => {
    await render(); expect(host.querySelector("select")).toBeNull(); expect(host.textContent).toContain("Outlined custom lettering");
    await click("Replace outlined lettering"); await change("Replacement font", font.id);
    expect(edits).toEqual([]); expect(host.querySelector("svg")).toBeNull();
    await click("Prepare lettering replacement");
    expect(edits).toEqual([{ kind: "replace_outlined_lettering", componentId: "synthetic-lettering", text: "A\u0301ster", contentKind: "brand_name", fontVersionId: font.id }]);
    expect(host.textContent).toContain("Save edit creates a new lettering version");
  });
  it("requires an explicit initials choice and confirmation only for a lettermark", async () => {
    await render({ logoType: "lettermark_monogram" }); await click("Replace outlined lettering");
    await change("Replacement content", "approved_initials"); await change("Approved initials", "AS"); await change("Replacement font", font.id);
    expect(edits).toEqual([]); await click("Prepare lettering replacement"); expect(edits).toHaveLength(0);
    const confirm = host.querySelector<HTMLInputElement>('[aria-label="Approve these initials"]')!;
    await act(async () => confirm.click()); await click("Prepare lettering replacement");
    expect(edits).toEqual([{ kind: "replace_outlined_lettering", componentId: "synthetic-lettering", text: "AS", contentKind: "approved_initials", fontVersionId: font.id }]);
  });
  it("does not offer initials for other logo types or let a fused illustration become text", async () => {
    await render(); await click("Replace outlined lettering"); expect(host.querySelector('[aria-label="Replacement content"]')).toBeNull();
    const document = separatedLogoDocument(); document.components[1]!.role = "illustration";
    await render({ document }); expect(button("Replace outlined lettering")).toBeUndefined(); expect(host.textContent).toContain("lettering-only");
  });
  it("never dispatches an edit on typing, blur, font choice, or cancel", async () => {
    await render(); await click("Replace outlined lettering"); await change("Replacement font", font.id);
    await click("Cancel lettering replacement"); expect(edits).toEqual([]); expect(host.querySelector("select")).toBeNull();
  });
  it("does not offer fonts without actual render and outline rights", async () => {
    const denied = structuredClone(font); denied.rights.permissions.outline = "unknown";
    await render({ fonts: [denied] }); expect(button("Replace outlined lettering").disabled).toBe(true); expect(host.textContent).toContain("render and outline permission");
  });
  it("keeps locks and unavailable state effective for every text action", async () => {
    await render({ lockedComponentIds: ["synthetic-lettering"] }); expect(button("Replace outlined lettering").disabled).toBe(true);
    await render({ disabledReason: "Resolve your pending request." }); expect(button("Replace outlined lettering").disabled).toBe(true); expect(host.textContent).toContain("Resolve your pending request.");
  });
  it("keeps the saved geometry while preparing explicit font and spacing intents", async () => {
    const document = separatedLogoDocument(), original = structuredClone(document), nextFont = structuredClone(font);
    nextFont.id = "00000000-0000-4000-8000-000000000108"; nextFont.asset.assetId = "00000000-0000-4000-8000-000000000109"; nextFont.asset.versionId = "00000000-0000-4000-8000-000000000110";
    document.components[1] = { ...document.components[1]!, editingKind: "editable_text", textSource: { text: "A\u0301ster", contentKind: "brand_name", font: font.asset, rightsEvidenceId: font.rights.id, faceIndex: 0, size: 40, variationAxes: {}, featureTags: {}, language: "en", script: "Latn", direction: "ltr", letterSpacing: 0, lineHeight: 1, shapingEngine: { id: "harfbuzzjs", version: "1.6.2" } } };
    await render({ document, fonts: [font, nextFont] });
    expect(host.querySelector('[style*="font-family"]')).toBeNull(); await change("Lettering font", nextFont.id); expect(edits).toEqual([]);
    await click("Use this font"); expect(edits[0]).toEqual({ kind: "font", componentId: "synthetic-lettering", fontVersionId: nextFont.id });
    await change("Letter spacing", "2.5"); expect(edits).toHaveLength(1);
    await click("Set spacing"); expect(edits[1]).toEqual({ kind: "spacing", componentId: "synthetic-lettering", letterSpacing: 2.5, lineHeight: 1 });
    expect(document.components[1]!.paths).toEqual(original.components[1]!.paths);
  });
  it("does not submit incomplete spacing values or unchanged selections", async () => {
    const document = separatedLogoDocument();
    document.components[1] = { ...document.components[1]!, editingKind: "editable_text", textSource: { text: "A\u0301ster", contentKind: "brand_name", font: font.asset, rightsEvidenceId: font.rights.id, faceIndex: 0, size: 40, variationAxes: {}, featureTags: {}, language: "en", script: "Latn", direction: "ltr", letterSpacing: 0, lineHeight: 1, shapingEngine: { id: "harfbuzzjs", version: "1.6.2" } } };
    await render({ document }); await click("Use this font"); await click("Set spacing"); expect(edits).toEqual([]);
    await change("Letter spacing", ""); await click("Set spacing"); expect(edits).toEqual([]); expect((host.querySelector('[aria-label="Letter spacing"]') as HTMLInputElement).value).toBe("");
  });

  it("does not expose an effective line-height control for single-line lettering", async () => {
    const document = separatedLogoDocument();
    document.components[1] = { ...document.components[1]!, editingKind: "editable_text", textSource: { text: "Aster", contentKind: "brand_name", font: font.asset, rightsEvidenceId: font.rights.id, faceIndex: 0, size: 40, variationAxes: {}, featureTags: {}, language: "en", script: "Latn", direction: "ltr", letterSpacing: 0, lineHeight: 1, shapingEngine: { id: "harfbuzzjs", version: "1.6.2" } } };
    await render({ document });
    expect(host.querySelector('[aria-label="Text line height"]')).toBeNull();
    expect(host.textContent).toContain("Single-line lettering keeps its saved line height");
  });

  it.each(["missing", "render-denied", "outline-denied"] as const)("disables existing initials edits when the exact saved font is %s", async unavailable => {
    const document = separatedLogoDocument(), availableFont = structuredClone(font);
    document.components[1] = { ...document.components[1]!, editingKind: "editable_text", textSource: { text: "AS", contentKind: "approved_initials", font: font.asset, rightsEvidenceId: font.rights.id, faceIndex: 0, size: 40, variationAxes: {}, featureTags: {}, language: "en", script: "Latn", direction: "ltr", letterSpacing: 0, lineHeight: 1, shapingEngine: { id: "harfbuzzjs", version: "1.6.2" } } };
    if (unavailable === "render-denied") availableFont.rights.permissions.render = "denied";
    if (unavailable === "outline-denied") availableFont.rights.permissions.outline = "denied";
    await render({ document, logoType: "lettermark_monogram", fonts: unavailable === "missing" ? [] : [availableFont] });
    expect(button("Set initials").closest("fieldset")!.disabled).toBe(true);
    expect(host.textContent).toContain("The exact saved font and rights record must be available");
    await click("Set initials"); expect(edits).toEqual([]);
  });
  it.each(["missing", "render-denied", "outline-denied"] as const)("guards the initials submit callback when the saved font is %s", async unavailable => {
    const document = separatedLogoDocument(), availableFont = structuredClone(font);
    document.components[1] = { ...document.components[1]!, editingKind: "editable_text", textSource: { text: "AS", contentKind: "approved_initials", font: font.asset, rightsEvidenceId: font.rights.id, faceIndex: 0, size: 40, variationAxes: {}, featureTags: {}, language: "en", script: "Latn", direction: "ltr", letterSpacing: 0, lineHeight: 1, shapingEngine: { id: "harfbuzzjs", version: "1.6.2" } } };
    if (unavailable === "render-denied") availableFont.rights.permissions.render = "denied";
    if (unavailable === "outline-denied") availableFont.rights.permissions.outline = "denied";
    await render({ document, logoType: "lettermark_monogram", fonts: unavailable === "missing" ? [] : [availableFont] });
    const form = button("Set initials").closest("form")!;
    // Exercise the callback independently of the browser's fieldset guard.
    button("Set initials").closest("fieldset")!.disabled = false;
    await change("Editable initials", "AZ");
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(edits).toEqual([]);
  });
  it("allows an explicit initials edit when its exact saved font has both permissions", async () => {
    const document = separatedLogoDocument();
    document.components[1] = { ...document.components[1]!, editingKind: "editable_text", textSource: { text: "AS", contentKind: "approved_initials", font: font.asset, rightsEvidenceId: font.rights.id, faceIndex: 0, size: 40, variationAxes: {}, featureTags: {}, language: "en", script: "Latn", direction: "ltr", letterSpacing: 0, lineHeight: 1, shapingEngine: { id: "harfbuzzjs", version: "1.6.2" } } };
    await render({ document, logoType: "lettermark_monogram" }); await change("Editable initials", "AZ"); await click("Set initials");
    expect(edits).toEqual([{ kind: "text", componentId: "synthetic-lettering", text: "AZ" }]);
  });

});
