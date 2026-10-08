// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversionReviewPresentation, type ConversionReviewReadiness } from "../../../src/features/logo-vector/components/conversion-review";
import { serializeLogoSvg } from "../../../src/features/logo-vector/model/svg";
import { separatedLogoDocument } from "./fixtures";

/** Synthetic native load/error events exercise React lifetime fencing, not a
 * real browser decoder or visual equivalence. The Blob bytes are checked too. */
describe("bounded canonical vector comparison", () => {
  let root: Root, host: HTMLDivElement, mounted: boolean;
  let reports: ConversionReviewReadiness[];
  const onReadinessChange = (report: ConversionReviewReadiness) => { reports.push(report); };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("fetch", vi.fn());
    let ordinal = 0; URL.createObjectURL = vi.fn(() => `blob:canonical-${++ordinal}`); URL.revokeObjectURL = vi.fn();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host); mounted = true; reports = [];
  });
  afterEach(async () => { if (mounted) await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const vectorImage = () => host.querySelector('svg[aria-label="Vector candidate"] > image')!;
  const originalImage = () => host.querySelector('img[alt="Original concept"]')!;
  async function event(target: Element, type: "load" | "error") { expect(target).not.toBeNull(); await act(async () => target.dispatchEvent(new Event(type))); }
  async function mount(document = separatedLogoDocument(), originalUrl: string | undefined = "blob:verified-original", scopeKey = "owner-1:revision-1") {
    await act(async () => root.render(createElement(ConversionReviewPresentation, { document, originalUrl, scopeKey, onReadinessChange })));
  }
  const blobText = (blob: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob); });

  it("keeps all 20000 paths in the exact validated SVG Blob and bounds total comparison DOM", async () => {
    const document = separatedLogoDocument(); document.components.splice(1);
    document.components[0]!.paths = Array.from({ length: 20000 }, (_, index) => ({ ...document.components[0]!.paths[0]!, id: `path-${index}` }));
    await mount(document);
    expect(host.querySelectorAll("*").length).toBeLessThan(32);
    expect(host.querySelectorAll("path")).toHaveLength(0);
    expect(vectorImage().getAttribute("href")).toBe("blob:canonical-1");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("image/svg+xml");
    const bytes = await blobText(blob);
    expect(bytes).toBe(new TextDecoder().decode(serializeLogoSvg(document)));
    expect(bytes.match(/<path /g)).toHaveLength(20000);
    expect(originalImage().getAttribute("src")).toBe("blob:verified-original");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires native load events for both exact images before reporting the comparison ready", async () => {
    const document = separatedLogoDocument(); document.viewBox = [10, 10, 200, 120];
    await mount(document);
    expect(reports.at(-1)).toEqual({ document, originalUrl: "blob:verified-original", scopeKey: "owner-1:revision-1", ready: false });
    expect(["x", "y", "width", "height"].map(name => vectorImage().getAttribute(name))).toEqual(["10", "10", "200", "120"]);
    expect(vectorImage().getAttribute("preserveAspectRatio")).toBe("none");
    await event(vectorImage(), "load"); expect(reports.at(-1)?.ready).toBe(false);
    await event(originalImage(), "load"); expect(reports.at(-1)?.ready).toBe(true);
    expect(host.querySelector('svg[aria-label="Vector candidate"]')?.getAttribute("aria-busy")).toBe("false");
    expect(host.textContent).toContain("Validated path geometry");
  });
  it.each(["document", "owner", "original"] as const)("revokes and resets on %s replacement and ignores previous load/error events", async change => {
    const first = separatedLogoDocument(); await mount(first);
    const previousVector = vectorImage(), previousOriginal = originalImage();
    await event(previousVector, "load"); await event(previousOriginal, "load");
    const next = change === "document" ? separatedLogoDocument() : first;
    if (change === "document") next.components[0]!.paths[0]!.fill!.color = "#123456";
    await mount(next, change === "original" ? "blob:next-original" : "blob:verified-original", change === "owner" ? "owner-2:revision-1" : "owner-1:revision-1");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:canonical-1");
    expect(vectorImage().getAttribute("href")).toBe("blob:canonical-2");
    expect(reports.at(-1)?.ready).toBe(false);
    await event(previousVector, "load"); await event(previousOriginal, "error");
    expect(reports.at(-1)?.ready).toBe(false); expect(host.querySelector('[role="alert"]')).toBeNull();
    await event(vectorImage(), "load"); await event(originalImage(), "load");
    expect(reports.at(-1)).toMatchObject({ document: next, ready: true });
  });
  it.each(["canonical", "original"] as const)("fails closed and clears readiness when the %s image fails after loading", async kind => {
    await mount(); const vector = vectorImage(), original = originalImage();
    await event(vector, "load"); await event(original, "load"); expect(reports.at(-1)?.ready).toBe(true);
    await event(kind === "canonical" ? vector : original, "error");
    expect(reports.at(-1)?.ready).toBe(false); expect(host.querySelector('[role="alert"]')?.textContent).toContain("unavailable");
    if (kind === "canonical") { expect(vectorImage()).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:canonical-1"); }
    else expect(originalImage()).toBeNull();
    await event(vector, "load"); await event(original, "load"); expect(reports.at(-1)?.ready).toBe(false);
  });
  it("releases its canonical URL exactly once on unmount and leaves the caller-owned original URL alone", async () => {
    await mount(); const vector = vectorImage(), original = originalImage();
    await event(vector, "load"); await event(original, "load");
    await act(async () => root.unmount()); mounted = false;
    expect(reports.at(-1)?.ready).toBe(false); const count = reports.length;
    await event(vector, "load"); await event(original, "error");
    expect(reports).toHaveLength(count); expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:canonical-1");
  });
  it("keeps the actual original visible but reports a Blob creation failure honestly", async () => {
    vi.mocked(URL.createObjectURL).mockImplementation(() => { throw new Error("Blob URL unavailable"); });
    await mount(); await event(originalImage(), "load");
    expect(vectorImage()).toBeNull(); expect(host.querySelector('[role="alert"]')?.textContent).toContain("Vector preview unavailable");
    expect(reports.at(-1)?.ready).toBe(false); expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
  it("rejects invalid canonical geometry before any SVG resource is made", async () => {
    const document = separatedLogoDocument(); document.components[0]!.paths[0]!.d = '<script>alert(1)</script>';
    await mount(document);
    expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(host.querySelector("script,path,image")).toBeNull();
    expect(host.textContent).toContain("Vector preview unavailable"); expect(reports.at(-1)?.ready).toBe(false);
  });
  it("never substitutes the canonical vector for a missing original or loads a remote original URL", async () => {
    await mount(separatedLogoDocument(), "https://example.com/unverified.png");
    await event(vectorImage(), "load");
    expect(originalImage()).toBeNull(); expect(host.textContent).toContain("Original preview unavailable");
    expect(reports.at(-1)?.ready).toBe(false); expect(fetch).not.toHaveBeenCalled();
  });
});
