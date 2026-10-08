// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogoManualEdit, LogoVectorDocument } from "../../../src/domain/logo-vector";
import { ComponentGrouping } from "../../../src/features/logo-vector/components/component-grouping";
import { applyLogoManualEdit } from "../../../src/features/logo-vector/model/edits";
import { serializeLogoSvg } from "../../../src/features/logo-vector/model/svg";
import { separatedLogoDocument } from "./fixtures";

function artwork(): LogoVectorDocument { const base = separatedLogoDocument(); return { ...base, components: [{ ...base.components[0]!, id: "trace", role: "whole_artwork" as const, paths: base.components.flatMap(component => component.paths) }] }; }

describe("bounded whole-path grouping controls", () => {
  let root: Root, host: HTMLDivElement, edits: LogoManualEdit[];
  beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", vi.fn());
    let ordinal = 0; URL.createObjectURL = vi.fn(() => `blob:grouping-preview-${++ordinal}`); URL.revokeObjectURL = vi.fn();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host); edits = []; });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const button = (name: string) => [...host.querySelectorAll("button")].find(item => item.textContent === name)!;
  async function click(name: string) { const target = button(name); expect(target, name).toBeDefined(); expect(target.disabled, name).toBe(false); await act(async () => target.click()); }
  async function field(label: string, value: string) {
    const target = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
    expect(target, label).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(target.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(target, value);
      target.dispatchEvent(new Event(target.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
  }
  async function region(id: string, role: string, bounds: number[]) {
    await field("Region ID", id); await field("Region role", role);
    for (const [index, name] of ["X", "Y", "width", "height"].entries()) await field(`Region ${name}`, String(bounds[index]));
    await click("Add region");
  }
  async function mount(doc: LogoVectorDocument = artwork(), lockedComponentIds: string[] = [], disabledReason?: string) {
    await act(async () => root.render(createElement(ComponentGrouping, { document: doc, lockedComponentIds, disabledReason, onEdit: edit => edits.push(edit) })));
  }
  it("lets the user label explicit rectangles, review exact membership and apply one unsaved grouping", async () => {
    const base = artwork(); await mount(base); await click("Group whole paths");
    await region("my-symbol", "symbol", [18, 18, 44, 44]);
    expect(host.textContent).toContain("1 whole path");
    await click("Preview grouping"); expect(host.querySelector('[role="alert"]')?.textContent).toContain("remaining paths");
    expect(edits).toEqual([]);
    await region("my-lettering", "lettering", [80, 25, 70, 40]); await click("Preview grouping");
    expect(host.querySelector('svg[aria-label="Grouping selection preview"]')).not.toBeNull();
    expect(host.textContent).toContain("2 components");
    expect(edits).toEqual([]); await click("Apply grouping");
    expect(edits).toEqual([{ kind: "group_components", regions: [{ id: "my-symbol", role: "symbol", bounds: [18, 18, 44, 44] }, { id: "my-lettering", role: "lettering", bounds: [80, 25, 70, 40] }] }]);
    expect(applyLogoManualEdit(base, edits[0]!).components[1]!.editingKind).toBe("outlined_custom");
    await act(async () => button("Apply grouping").click()); expect(edits).toHaveLength(1);
  });
  it("cancels a draft selection without emitting edits and starts the next selection empty", async () => {
    await mount(); await click("Group whole paths"); await region("my-symbol", "symbol", [18, 18, 44, 44]); await click("Cancel grouping");
    expect(host.querySelector('svg[aria-label="Grouping selection preview"]')).toBeNull();
    await click("Group whole paths"); expect(host.textContent).not.toContain("my-symbol"); expect(button("Preview grouping").disabled).toBe(true); expect(edits).toEqual([]);
  });
  it("rejects fused-path selection visibly and requires another preview after changing regions", async () => {
    await mount(); await click("Group whole paths"); await region("cut-lettering", "lettering", [80, 25, 70, 20]); await click("Preview grouping");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("compound path"); expect(button("Apply grouping").disabled).toBe(true); expect(edits).toEqual([]);
    await click("Remove cut-lettering"); await region("whole", "whole_artwork", [0, 0, 200, 120]); await click("Preview grouping"); expect(button("Apply grouping").disabled).toBe(false);
    await click("Remove whole"); expect(button("Apply grouping").disabled).toBe(true);
  });
  it("keeps closed grouping unavailable during another pending edit", async () => {
    await mount(artwork(), [], "Save or discard this change before editing again.");
    expect(button("Group whole paths").disabled).toBe(true); expect(host.textContent).toContain("Save or discard"); expect(edits).toEqual([]);
  });
  it("protects touched or shifted locks in preview while allowing unaffected leading locked components", async () => {
    const base = artwork(), fixed = separatedLogoDocument().components[0]!; fixed.id = "locked-symbol"; fixed.paths[0]!.id = "locked-path"; fixed.transform.y = 50;
    base.components.push(fixed); await mount(base, [fixed.id]); await click("Group whole paths");
    await region("my-symbol", "symbol", [18, 18, 44, 44]); await region("my-lettering", "lettering", [80, 25, 70, 40]); await click("Preview grouping");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("locked component"); expect(button("Apply grouping").disabled).toBe(true);
    await click("Cancel grouping"); base.components.unshift(base.components.pop()!); await mount(base, [fixed.id]); await click("Group whole paths");
    await region("my-symbol", "symbol", [18, 18, 44, 44]); await region("my-lettering", "lettering", [80, 25, 70, 40]); await click("Preview grouping"); await click("Apply grouping"); expect(edits).toHaveLength(1);
  });
  it("keeps total DOM bounded at the 20000-path document limit using exact canonical SVG bytes", async () => {
    const base = artwork(); base.components[0]!.paths = Array.from({ length: 20000 }, (_, index) => ({ ...base.components[0]!.paths[0]!, id: `path-${index}` }));
    await mount(base); await click("Group whole paths");
    expect(host.querySelectorAll("input")).toHaveLength(5); expect(host.querySelectorAll("select")).toHaveLength(1);
    expect(host.textContent).toContain("20000 paths"); expect(edits).toEqual([]);
    expect(host.querySelectorAll("*").length).toBeLessThan(80);
    expect(host.querySelectorAll("path")).toHaveLength(0);
    const image = host.querySelector('svg[aria-label="Grouping selection preview"] > image')!;
    expect(image).not.toBeNull(); expect(image.getAttribute("href")).toBe("blob:grouping-preview-1");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("image/svg+xml");
    const bytes = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob); });
    expect(bytes).toBe(new TextDecoder().decode(serializeLogoSvg(base)));
    expect(bytes.match(/<path /g)).toHaveLength(20000);
    await region("whole", "whole_artwork", [0, 0, 200, 120]);
    expect(host.querySelectorAll("*").length).toBeLessThan(90); expect(host.querySelectorAll("rect")).toHaveLength(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
  it("revokes each isolated preview on document replacement, cancel and unmount", async () => {
    const first = artwork(); first.viewBox = [10, 10, 200, 120];
    await mount(first); await click("Group whole paths");
    const currentImage = () => host.querySelector('svg[aria-label="Grouping selection preview"] > image')!;
    expect(currentImage()).not.toBeNull();
    expect(["x", "y", "width", "height"].map(name => currentImage().getAttribute(name))).toEqual(["10", "10", "200", "120"]);
    expect(currentImage().getAttribute("preserveAspectRatio")).toBe("none");
    const oldUrl = currentImage().getAttribute("href");
    const second = structuredClone(first); second.components[0]!.paths[0]!.fill!.color = "#123456";
    await mount(second);
    expect(currentImage().getAttribute("href")).toBe("blob:grouping-preview-2");
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(oldUrl);
    await click("Cancel grouping");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:grouping-preview-2");
    await click("Group whole paths"); expect(currentImage().getAttribute("href")).toBe("blob:grouping-preview-3");
    await act(async () => root.render(null));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:grouping-preview-3");
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3); expect(host.querySelector("image")).toBeNull();
  });
});
