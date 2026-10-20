// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VariantReview } from "@/features/identity-deliverables/components/variant-review";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import type { LogoVariantSet } from "@/domain/logo-deliverables";
import { resolvedFixture, syntheticDocument } from "./fixtures";

vi.mock("server-only", () => ({}));

// Synthetic immutable metadata and releasable URLs; not browser raster QA.
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture() {
  const set = resolvedFixture(syntheticDocument(), () => "a".repeat(64)).resolved.set;
  set.items = [set.items[0]!];
  const release = vi.fn(), previewAsset = vi.fn<AccountLogoClient["previewAsset"]>(async () => ({ url: "blob:variant-one", release }));
  const client = { previewAsset } as unknown as AccountLogoClient;
  const onSubmit = vi.fn();
  const render = async (value: LogoVariantSet = set, transport = client) => { await act(async () => root.render(createElement(VariantReview, { set: value, client: transport, disabled: false, reviewed: false, onSubmit }))); };
  return { set, client, previewAsset, release, render, onSubmit };
}
const image = () => host.querySelector<HTMLImageElement>("img");
const checkbox = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const save = () => [...host.querySelectorAll("button")].find(node => node.textContent === "Save visual review")!;
async function accept() { await act(async () => image()!.dispatchEvent(new Event("load"))); await act(async () => checkbox().click()); expect(save().disabled).toBe(false); }

describe("variant preview immutable lifetime", () => {
  it("keeps the image, URL and checked review across equivalent polling receipts", async () => {
    const f = fixture(); await f.render(); await accept(); const before = image();
    for (let i = 0; i < 3; i++) { const next = structuredClone(f.set); next.items[0]!.preview!.verification.checkedAt = `2026-10-07T00:00:0${i + 1}Z`; await f.render(next); }
    expect(f.previewAsset).toHaveBeenCalledTimes(1); expect(f.release).not.toHaveBeenCalled(); expect(image()).toBe(before);
    expect(checkbox().checked).toBe(true); expect(save().disabled).toBe(false);
  });
  it.each(["hash", "publication", "purpose", "version", "rights", "mime"] as const)("hides old bytes and clears acceptance when %s evidence changes", async field => {
    const f = fixture(); await f.render(); await accept();
    const next = structuredClone(f.set), receipt = next.items[0]!.preview!;
    if (field === "hash") { receipt.reference.contentHash = "b".repeat(64); receipt.verification.contentHash = "b".repeat(64); }
    if (field === "publication") receipt.publicationState = "staged";
    if (field === "purpose") receipt.purpose = "reference_media";
    if (field === "version") receipt.reference.versionId = "95000000-0000-4000-8000-000000009999";
    if (field === "rights") receipt.rightsEvidenceId = "95000000-0000-4000-8000-000000009998";
    if (field === "mime") receipt.verification.mimeType = "image/jpeg";
    const pending = deferred<{ url: string; release(): void }>(), returned = deferred<{ url: string; release(): void }>();
    f.previewAsset.mockReturnValueOnce(pending.promise).mockReturnValueOnce(returned.promise);
    await f.render(next); expect(image()).toBeNull(); expect(f.release).toHaveBeenCalledTimes(1); expect(checkbox().checked).toBe(false); expect(save().disabled).toBe(true);
    await f.render(f.set); expect(image()).toBeNull(); expect(save().disabled).toBe(true);
    const lateRelease = vi.fn(); await act(async () => pending.resolve({ url: "blob:late", release: lateRelease }));
    expect(lateRelease).toHaveBeenCalledOnce(); expect(image()).toBeNull();
    await act(async () => returned.resolve({ url: "blob:returned", release: vi.fn() }));
    await act(async () => image()!.dispatchEvent(new Event("load"))); expect(checkbox().checked).toBe(false); expect(save().disabled).toBe(true);
  });
  it("clears review and hides old bytes for a different client", async () => {
    const f = fixture(); await f.render(); await accept();
    const pending = deferred<{ url: string; release(): void }>(); const next = { previewAsset: vi.fn(() => pending.promise) } as unknown as AccountLogoClient;
    await f.render(f.set, next); expect(image()).toBeNull(); expect(save().disabled).toBe(true); expect(f.release).toHaveBeenCalledOnce();
    const release = vi.fn(); await act(async () => root.render(null)); await act(async () => pending.resolve({ url: "blob:late-client", release })); expect(release).toHaveBeenCalledOnce();
  });
  it("removes acceptance when preview disappears or the loaded image errors", async () => {
    const f = fixture(); await f.render(); await accept();
    await act(async () => image()!.dispatchEvent(new Event("error"))); expect(checkbox().checked).toBe(false); expect(save().disabled).toBe(true);
    const next = structuredClone(f.set); next.items[0]!.preview = null; await f.render(next); expect(image()).toBeNull(); expect(save().disabled).toBe(true);
  });
});
