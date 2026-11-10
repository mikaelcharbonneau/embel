// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetPreview } from "@/components/assets/asset-preview";
import { ReferencePreview } from "@/components/identity/reference-preview";
import { LogoVerifiedPreview } from "@/components/logo-creation/verified-preview";
import { IdentitySystemBoard } from "@/components/identity/identity-system-board";
import type { AccountAssetsClient } from "@/components/assets/account-assets-client";
import type { AccountReferenceClient } from "@/components/identity/account-reference-client";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import type { AccountIdentityClient } from "@/components/identity/account-identity-client";
import { assetRevisionFreshness, assetVersionDetailSchema, type AssetVersionReference } from "@/domain/asset-library";
import type { IdentityReferenceMedia } from "@/domain/identity-references";
import type { IdentityBoardPreview } from "@/domain/project-identity";
import type { IdentityAssetReceipt } from "@/domain/logo-deliverables";

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const time = "2026-10-20T00:00:00Z";
const reference = (): AssetVersionReference => ({
  ownerId: id(1),
  projectId: id(2),
  assetId: id(3),
  versionId: id(4),
  contentHash: "a".repeat(64),
});
function fixture() {
  const ref = reference();
  const version = assetVersionDetailSchema.parse({
    ...ref,
    inputHash: "b".repeat(64),
    inputRevision: 1,
    versionNumber: 1,
    createdAt: time,
    mimeType: "image/png",
    format: "png",
    provenance: { status: "legacy_unverified" },
    vectorStatus: "unverified",
    licenseStatus: "unverified",
    fileState: "verified",
    fileVerification: {
      status: "verified",
      checkedAt: time,
      contentHash: ref.contentHash,
      mimeType: "image/png",
      byteLength: 68,
    },
    freshness: assetRevisionFreshness(1, 1),
  });
  const media: IdentityReferenceMedia = { ...ref, mimeType: "image/png", purpose: "reference_media" };
  const receipt: IdentityAssetReceipt = {
    id: id(5),
    reference: ref,
    verification: {
      status: "verified",
      checkedAt: time,
      contentHash: ref.contentHash,
      mimeType: "image/png",
      byteLength: 68,
    },
    purpose: "brand_asset",
    sourceReceiptId: id(6),
    rightsEvidenceId: null,
    publicationState: "committed",
  };
  const board: IdentityBoardPreview = {
    asset: { ...ref, purpose: "brand_asset", mimeType: "image/png" },
    depictsSystemVersionId: id(7),
    staleComponents: [],
  };
  return { version, media, receipt, board };
}
type Fixture = ReturnType<typeof fixture>;
type Kind = "asset" | "reference" | "logo" | "board";
type Preview = { url: string; release: ReturnType<typeof vi.fn> };
function client() {
  let current = true;
  const requests: { signal: AbortSignal; resolve: (value: Preview | null) => void; reject: (cause: Error) => void }[] =
    [];
  const read = vi.fn(
    (_value: unknown, signal: AbortSignal) =>
      new Promise<Preview | null>((resolve, reject) => requests.push({ signal, resolve, reject })),
  );
  return {
    preview: read,
    previewAsset: read,
    current: () => current,
    invalidate: () => {
      current = false;
    },
    requests,
    read,
  };
}
type Client = ReturnType<typeof client>;
const preview = (name = "saved"): Preview => ({ url: `blob:fixture-${name}`, release: vi.fn() });
let host: HTMLDivElement, root: Root;
async function render(node: ReactNode) {
  await act(async () => root.render(node));
}
async function show(kind: Kind, value: Fixture, source: Client) {
  await render(
    kind === "asset" ? (
      <AssetPreview client={source as unknown as AccountAssetsClient} version={value.version} label="Saved asset" />
    ) : kind === "reference" ? (
      <ReferencePreview
        client={source as unknown as AccountReferenceClient}
        media={value.media}
        label="Saved reference"
      />
    ) : kind === "logo" ? (
      <LogoVerifiedPreview client={source as unknown as AccountLogoClient} receipt={value.receipt} />
    ) : (
      <IdentitySystemBoard client={source as unknown as AccountIdentityClient} board={value.board} name="Saved brand" />
    ),
  );
}
async function settle(source: Client, index: number, value: Preview | null) {
  await act(async () => source.requests[index]!.resolve(value));
}
function changeReference(value: Fixture, patch: Partial<AssetVersionReference>) {
  return {
    version: { ...value.version, ...patch },
    media: { ...value.media, ...patch },
    receipt: { ...value.receipt, reference: { ...value.receipt.reference, ...patch } },
    board: { ...value.board, asset: { ...value.board.asset, ...patch } },
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private disconnected = false;
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        queueMicrotask(() => {
          if (!this.disconnected)
            this.callback(
              [{ isIntersecting: true, target } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            );
        });
      }
      disconnect() {
        this.disconnected = true;
      }
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe.each<Kind>(["asset", "reference", "logo", "board"])("%s private preview continuity", (kind) => {
  it("keeps the same image and verified blob for deep-cloned equivalent snapshots", async () => {
    const source = client(),
      value = fixture(),
      file = preview();
    await show(kind, value, source);
    await settle(source, 0, file);
    const image = host.querySelector("img");
    expect(image?.getAttribute("src")).toBe(file.url);
    for (let index = 0; index < 3; index++) await show(kind, structuredClone(value), source);
    expect(host.querySelector("img")).toBe(image);
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(file.release).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<AssetVersionReference>]>([
    ["owner", { ownerId: id(10) }],
    ["project", { projectId: id(10) }],
    ["asset", { assetId: id(10) }],
    ["version", { versionId: id(10) }],
    ["hash", { contentHash: "c".repeat(64) }],
  ])("blanks and releases the old preview when its %s changes", async (_field, patch) => {
    const source = client(),
      value = fixture(),
      first = preview("first"),
      second = preview("second");
    await show(kind, value, source);
    await settle(source, 0, first);
    await show(kind, changeReference(value, patch), source);
    expect(host.querySelector("img")).toBeNull();
    expect(first.release).toHaveBeenCalledTimes(1);
    expect(source.requests[0]!.signal.aborted).toBe(true);
    await settle(source, 1, second);
    expect(host.querySelector("img")?.getAttribute("src")).toBe(second.url);
  });

  it("does not reuse a preview across a new verified client or account generation", async () => {
    const previous = client(),
      next = client(),
      value = fixture(),
      first = preview("old-client"),
      second = preview("new-client");
    await show(kind, value, previous);
    await settle(previous, 0, first);
    await show(kind, structuredClone(value), next);
    expect(host.querySelector("img")).toBeNull();
    expect(first.release).toHaveBeenCalledTimes(1);
    await settle(next, 0, second);
    expect(host.querySelector("img")?.getAttribute("src")).toBe(second.url);
  });

  it("releases a late response after switching client and ignores a stale error", async () => {
    const previous = client(),
      next = client(),
      value = fixture(),
      old = preview("late"),
      fresh = preview("current");
    await show(kind, value, previous);
    await show(kind, value, next);
    await settle(next, 0, fresh);
    await settle(previous, 0, old);
    expect(old.release).toHaveBeenCalledTimes(1);
    expect(host.querySelector("img")?.getAttribute("src")).toBe(fresh.url);
    const superseded = client();
    await show(kind, value, superseded);
    await show(kind, value, next);
    await act(async () => superseded.requests[0]!.reject(new Error("Stale private failure")));
    expect(host.textContent).not.toContain("unavailable");
  });

  it("never shows a late previous-version response", async () => {
    const source = client(),
      value = fixture(),
      late = preview("late-version"),
      fresh = preview("current-version");
    await show(kind, value, source);
    await show(kind, changeReference(value, { versionId: id(11) }), source);
    await settle(source, 0, late);
    expect(late.release).toHaveBeenCalledTimes(1);
    expect(host.querySelector("img")).toBeNull();
    await settle(source, 1, fresh);
    expect(host.querySelector("img")?.getAttribute("src")).toBe(fresh.url);
  });

  it("does not resurrect a released blob after switching away and back before the next read finishes", async () => {
    const source = client(),
      value = fixture(),
      old = preview("released"),
      fresh = preview("returned");
    await show(kind, value, source);
    await settle(source, 0, old);
    await show(kind, changeReference(value, { versionId: id(11) }), source);
    await show(kind, value, source);
    expect(host.querySelector("img")).toBeNull();
    expect(old.release).toHaveBeenCalledTimes(1);
    await settle(source, 2, fresh);
    expect(host.querySelector("img")?.getAttribute("src")).toBe(fresh.url);
  });

  it("revalidates a changed MIME contract even for the same version and hash", async () => {
    const source = client(),
      value = fixture(),
      old = preview();
    await show(kind, value, source);
    await settle(source, 0, old);
    const next: Fixture = {
      ...value,
      version: { ...value.version, mimeType: "image/webp", format: "webp" },
      media: { ...value.media, mimeType: "image/webp" },
      receipt: { ...value.receipt, verification: { ...value.receipt.verification, mimeType: "image/webp" } },
      board: { ...value.board, asset: { ...value.board.asset, mimeType: "image/webp" } },
    };
    await show(kind, next, source);
    expect(host.querySelector("img")).toBeNull();
    expect(old.release).toHaveBeenCalledTimes(1);
    expect(source.read).toHaveBeenCalledTimes(2);
  });

  it("releases a late preview after unmount", async () => {
    const source = client(),
      late = preview("unmounted");
    await show(kind, fixture(), source);
    await render(null);
    await settle(source, 0, late);
    expect(late.release).toHaveBeenCalledTimes(1);
    expect(host.querySelector("img")).toBeNull();
  });
});

it("keeps the bytes when only a verification observation time or project freshness changes", async () => {
  const source = client(),
    value = fixture(),
    file = preview();
  await show("asset", value, source);
  await settle(source, 0, file);
  const next: Fixture = {
    ...value,
    version: {
      ...value.version,
      freshness: assetRevisionFreshness(1, 2),
      fileVerification: value.version.fileVerification
        ? { ...value.version.fileVerification, checkedAt: "2026-10-20T00:10:00Z" }
        : null,
    },
  };
  await show("asset", next, source);
  expect(source.read).toHaveBeenCalledTimes(1);
  expect(file.release).not.toHaveBeenCalled();
});

it("revokes a retained Asset preview when the file becomes unavailable", async () => {
  const source = client(),
    value = fixture(),
    file = preview();
  await show("asset", value, source);
  await settle(source, 0, file);
  await show(
    "asset",
    {
      ...value,
      version: {
        ...value.version,
        fileState: "missing_or_invalid",
        fileVerification: { status: "missing_or_invalid", checkedAt: time },
      },
    },
    source,
  );
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("File unavailable");
  expect(file.release).toHaveBeenCalledTimes(1);
  expect(source.read).toHaveBeenCalledTimes(1);
});

it("revokes metadata-only and removed Asset previews without requesting their bytes", async () => {
  const source = client(),
    value = fixture(),
    file = preview();
  await show("asset", value, source);
  await settle(source, 0, file);
  await show(
    "asset",
    { ...value, version: { ...value.version, fileState: "metadata_only", fileVerification: null } },
    source,
  );
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("Metadata only");
  expect(file.release).toHaveBeenCalledTimes(1);
  expect(source.read).toHaveBeenCalledTimes(1);
  await show("asset", value, source);
  const restored = preview("restored");
  await settle(source, 1, restored);
  await render(<AssetPreview client={source as unknown as AccountAssetsClient} version={null} label="Removed asset" />);
  expect(host.querySelector("img")).toBeNull();
  expect(restored.release).toHaveBeenCalledTimes(1);
  expect(source.read).toHaveBeenCalledTimes(2);
});

it("does not retain a Logo receipt whose publication status changes", async () => {
  const source = client(),
    value = fixture(),
    file = preview();
  await show("logo", value, source);
  await settle(source, 0, file);
  await show("logo", { ...value, receipt: { ...value.receipt, publicationState: "staged" } }, source);
  expect(host.querySelector("img")).toBeNull();
  expect(file.release).toHaveBeenCalledTimes(1);
  await settle(source, 1, null);
  expect(host.textContent).toContain("unavailable");
});

it.each(["contentHash", "byteLength"] as const)(
  "revalidates changed Logo verification %s without reusing the old blob",
  async (field) => {
    const source = client(),
      value = fixture(),
      file = preview();
    await show("logo", value, source);
    await settle(source, 0, file);
    const next: Fixture = {
      ...value,
      receipt: {
        ...value.receipt,
        verification: {
          ...value.receipt.verification,
          ...(field === "contentHash"
            ? { contentHash: "c".repeat(64) }
            : { byteLength: value.receipt.verification.byteLength + 1 }),
        },
      },
    };
    await show("logo", next, source);
    expect(host.querySelector("img")).toBeNull();
    expect(file.release).toHaveBeenCalledTimes(1);
    expect(source.read).toHaveBeenCalledTimes(2);
    await settle(source, 1, null);
    expect(host.textContent).toContain("unavailable");
  },
);

it.each<Kind>(["asset", "reference", "board"])(
  "hides %s immediately when its client is no longer current",
  async (kind) => {
    const source = client(),
      value = fixture(),
      file = preview();
    await show(kind, value, source);
    await settle(source, 0, file);
    source.invalidate();
    await show(kind, value, source);
    expect(host.querySelector("img")).toBeNull();
  },
);
