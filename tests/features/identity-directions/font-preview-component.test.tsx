// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FontPicker } from "@/features/identity-directions/components/font-picker";
import type { FontPreviewReader, FontPreviewResult } from "@/features/identity-directions/model/font-preview";
import { directionFixture, id } from "./fixtures";

let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); });
const ready = (): FontPreviewResult => ({ status: "ready", document: { version: 1, viewBox: [0, 0, 20, 20], components: [{ id: "specimen", role: "lettering", editingKind: "geometry", transform: { x: 0, y: 0, scale: 1, rotation: 0 }, paths: [{ id: "glyph", d: "M1 1L19 1L19 19L1 19Z", fill: { color: "#000000", opacity: 1 }, stroke: null, fillRule: "nonzero" }] }] } });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
async function mount(readPreview?: FontPreviewReader, patch?: (overview: ReturnType<typeof directionFixture>) => void, closed = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const overview = directionFixture(); patch?.(overview);
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const render = async (reader = readPreview) => { await act(async () => {
    const picker = createElement(FontPicker, { typography: overview.typography[0]!, fonts: overview.fonts, readPreview: reader });
    root!.render(closed ? createElement("details", null, createElement("summary", null, "Typography"), picker) : picker);
  }); };
  await render(); return { container, overview, render };
}
describe("owned font specimen presentation", () => {
  it("renders the returned verified glyph paths instead of permanently claiming previews are unavailable", async () => {
    const f = await mount(async () => ready());
    expect(f.container.querySelector('svg[role="img"] path')).not.toBeNull();
    expect(f.container.textContent).not.toContain("Font previews are unavailable.");
    expect(f.container.textContent).toContain("Exact specimen: “Fluid studio 123”");
    expect(f.container.textContent).toContain("scaled to fit");
  });
  it("keeps an unavailable source honest without a fake system-font specimen", async () => {
    const f = await mount(); expect(f.container.querySelector("svg")).toBeNull(); expect(f.container.textContent).toContain("verified account font source is required");
  });
  it.each(["unreviewed", "outline_denied", "display_denied"])("does not fetch or render a %s font", async reason => {
    const reader = vi.fn<FontPreviewReader>(async () => ready());
    const f = await mount(reader, overview => {
      const font = overview.fonts[0]!;
      if (reason === "unreviewed") { font.source = "user_upload"; font.rights.sourceKind = "user_declaration"; font.rights.reviewedAt = null; }
      else font.rights.permissions[reason === "outline_denied" ? "outline" : "render"] = "denied";
    });
    expect(reader).not.toHaveBeenCalled(); expect(f.container.querySelector("svg")).toBeNull(); expect(f.container.textContent).toContain("Reviewed display and outline permissions are required");
    if (reason === "unreviewed") expect(f.container.textContent).toContain("Declared allowed · unreviewed");
  });
  it.each(["foreign", "duplicate"])("rejects %s font membership without reading bytes", async reason => {
    const reader = vi.fn<FontPreviewReader>(async () => ready());
    const f = await mount(reader, overview => { if (reason === "foreign") overview.fonts[0]!.asset.ownerId = id(99); else overview.fonts.push(structuredClone(overview.fonts[0]!)); });
    expect(reader).not.toHaveBeenCalled(); expect(f.container.textContent).toContain("Font unavailable");
  });
  it("aborts old specimen reads and ignores late completion after switching typography", async () => {
    const first = deferred<FontPreviewResult>(), calls: AbortSignal[] = [];
    const reader: FontPreviewReader = async (_font, _input, signal) => { calls.push(signal); return calls.length === 1 ? first.promise : { status: "unavailable", reason: "missing_glyphs" }; };
    const f = await mount(reader); expect(f.container.textContent).toContain("Loading font specimen");
    f.overview.typography[0]!.styles[0]!.sampleText = "Other specimen"; await f.render();
    expect(calls[0]!.aborted).toBe(true); expect(f.container.textContent).toContain("missing characters");
    await act(async () => first.resolve(ready())); expect(f.container.querySelector("svg")).toBeNull(); expect(f.container.textContent).toContain("Other specimen");
  });
  it("hides earlier geometry when the reader/account generation changes", async () => {
    const f = await mount(async () => ready()), pending = deferred<FontPreviewResult>();
    await f.render(async () => pending.promise); expect(f.container.querySelector("svg")).toBeNull(); expect(f.container.textContent).toContain("Loading font specimen");
    await act(async () => pending.resolve({ status: "unavailable", reason: "style_unsupported" }));
    expect(f.container.textContent).toContain("saved weight or italic style is not supported");
  });
  it("aborts pending work on unmount", async () => {
    let signal: AbortSignal | undefined; const pending = deferred<FontPreviewResult>();
    await mount(async (_font, _input, value) => { signal = value; return pending.promise; });
    await act(async () => root!.unmount()); root = null; expect(signal?.aborted).toBe(true); await act(async () => pending.resolve(ready()));
  });
  it("offers an explicit retry after a failed read and renders a successful retry", async () => {
    let calls = 0; const f = await mount(async () => { if (++calls === 1) throw new Error("offline"); return ready(); });
    expect(f.container.textContent).toContain("could not be loaded");
    await act(async () => f.container.querySelector<HTMLButtonElement>("button")!.click());
    expect(calls).toBe(2); expect(f.container.querySelector("svg path")).not.toBeNull();
  });
  it("starts only when typography is opened and aborts when it is closed", async () => {
    const pending = deferred<FontPreviewResult>(), calls: AbortSignal[] = [];
    const reader = vi.fn<FontPreviewReader>(async (_font, _input, signal) => { calls.push(signal); return pending.promise; });
    const f = await mount(reader, undefined, true), details = f.container.querySelector("details")!;
    expect(reader).not.toHaveBeenCalled();
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); }); expect(reader).toHaveBeenCalledOnce();
    await act(async () => { details.open = false; details.dispatchEvent(new Event("toggle")); }); expect(calls[0]!.aborted).toBe(true);
    await act(async () => pending.resolve(ready())); expect(f.container.querySelector("svg")).toBeNull();
  });
  it("rejects unsupported geometry rather than inserting active SVG markup", async () => {
    const bad = ready(); if (bad.status === "ready") bad.document.components[0]!.paths[0]!.d = '<script>alert(1)</script>';
    const f = await mount(async () => bad); expect(f.container.querySelector("svg")).toBeNull(); expect(f.container.textContent).toContain("could not be loaded");
  });
});
