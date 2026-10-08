import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { ApprovedDeliverableSnapshot } from "../../../src/domain/logo-deliverables";
import { buildLogoExport, LogoExportPreparationError, type PreparedLogoExport } from "../../../src/features/identity-deliverables/server/package";
import { publishPartialLogoExport, publishPreparedLogoExport } from "../../../src/features/identity-deliverables/server/publish";
import { approvedExportFixture, hashBytes, id } from "./fixtures";
import { publicationFixture } from "./publication-fixture";
let snapshot: ApprovedDeliverableSnapshot, prepared: PreparedLogoExport;
beforeAll(async () => { snapshot = await approvedExportFixture(); prepared = await buildLogoExport(snapshot, new AbortController().signal); });
function rewriteArchive(value: PreparedLogoExport, mutate?: (manifest: Record<string, unknown>) => void): void {
  const entries = unzipSync(value.archive.bytes), manifest = JSON.parse(strFromU8(entries["manifest.json"]!)) as Record<string, unknown>;
  for (const file of value.files) entries[file.name] = new Uint8Array(file.bytes);
  mutate?.(manifest); entries["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  value.archive.bytes = zipSync(entries); value.archive.contentHash = hashBytes(value.archive.bytes);
}
function probeArchiveAllocations(snapshot: ApprovedDeliverableSnapshot, prepared: PreparedLogoExport): Promise<{ rejectedAllocations: number[]; rejected: boolean; storageWrites: number }> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("./zip-allocation-probe.ts", import.meta.url)), [], { execArgv: ["--conditions=react-server", "--import", "tsx"], serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error("ZIP probe timed out")); }, 10_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("message", result => { clearTimeout(timer); child.kill(); if (result && typeof result === "object" && "probeFailed" in result) reject(new Error("ZIP probe failed")); else resolve(result as { rejectedAllocations: number[]; rejected: boolean; storageWrites: number }); });
    child.send({ snapshot, prepared });
  });
}
function exaggerateZipSizes(bytes: Uint8Array, mode: "per-entry" | "cumulative"): Uint8Array {
  const copied = new Uint8Array(bytes), view = new DataView(copied.buffer), end = copied.length - 22;
  let offset = view.getUint32(end + 16, true);
  const count = mode === "per-entry" ? 1 : 5;
  for (let index = 0; index < count; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Synthetic ZIP central directory not found");
    view.setUint32(offset + 24, 52_428_800 + (mode === "per-entry" ? 1 : 0), true);
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return copied;
}
describe("synthetic leased staged publication", () => {
  it("readbacks every real file and stages immutable membership without ready state", async () => {
    const fixture = publicationFixture(snapshot), before = JSON.stringify(snapshot);
    const receipt = await publishPreparedLogoExport(fixture.job, snapshot, prepared, fixture.dependencies, new AbortController().signal);
    expect(receipt.publicationState).toBe("staged");
    expect(receipt.assetReceiptIds).toHaveLength(prepared.files.length + 1);
    expect(fixture.storage.size).toBe(prepared.files.length + 1);
    expect(fixture.counters().stages).toBe(1);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
  it("accepts an unchanged canonical manifest round trip", async () => {
    const changed = structuredClone(prepared), fixture = publicationFixture(snapshot);
    rewriteArchive(changed);
    const receipt = await publishPreparedLogoExport(fixture.job, snapshot, changed, fixture.dependencies, new AbortController().signal);
    expect(receipt.assetReceiptIds).toHaveLength(prepared.files.length + 1);
    expect(fixture.counters().stages).toBe(1);
  });
  it("stages earlier verified files as an explicit incomplete group without inventing a ZIP", async () => {
    const fixture = publicationFixture(snapshot), partial = new LogoExportPreparationError("file_failed", prepared.files.slice(0, 3));
    const receipt = await publishPartialLogoExport(fixture.job, snapshot, partial, fixture.dependencies, new AbortController().signal);
    expect(receipt.assetReceiptIds).toHaveLength(3);
    expect([...fixture.storage.values()].map(file => file.mimeType).sort()).toEqual(["application/pdf", "image/png", "image/svg+xml"]);
    expect(fixture.details()).toMatchObject({ completeness: "partial", failure: "file_failed", files: prepared.files.slice(0, 3).map(file => ({ name: file.name, role: file.role, contentHash: file.contentHash })) });
  });
  it("rejects unverified or foreign partial membership before storage", async () => {
    for (const mode of ["missing-proof", "unknown-name", "wrong-role", "wrong-hash", "empty"] as const) {
      const files = structuredClone(prepared.files.slice(0, 3));
      if (mode === "missing-proof") files[0]!.verification = null;
      if (mode === "unknown-name") files[0]!.name = "unreviewed.svg";
      if (mode === "wrong-role") files[0]!.role = "avatar";
      if (mode === "wrong-hash") files[0]!.contentHash = "f".repeat(64);
      const fixture = publicationFixture(snapshot);
      await expect(publishPartialLogoExport(fixture.job, snapshot, new LogoExportPreparationError("file_failed", mode === "empty" ? [] : files), fixture.dependencies, new AbortController().signal)).rejects.toThrow();
      expect(fixture.storage.size).toBe(0);
    }
  });
  it("same exact bytes replay without duplicate objects or overwrites", async () => {
    const fixture = publicationFixture(snapshot), signal = new AbortController().signal;
    const a = await publishPreparedLogoExport(fixture.job, snapshot, prepared, fixture.dependencies, signal), b = await publishPreparedLogoExport(fixture.job, snapshot, prepared, fixture.dependencies, signal);
    expect(b).toEqual(a); expect(fixture.counters().writes).toBe(prepared.files.length + 1);
  });
  it("publication copies Buffer-backed bytes before lease awaits", async () => {
    const mutable = { ...prepared, files: prepared.files.map(file => ({ ...file, bytes: Buffer.from(file.bytes) })), archive: { ...prepared.archive, bytes: Buffer.from(prepared.archive.bytes) } };
    const fixture = publicationFixture(snapshot), originalAssert = fixture.dependencies.assertCurrentLease;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    fixture.dependencies.assertCurrentLease = async () => { await gate; await originalAssert(); };
    const pending = publishPreparedLogoExport(fixture.job, snapshot, mutable, fixture.dependencies, new AbortController().signal);
    mutable.files[0]!.bytes.fill(0); release();
    expect((await pending).assetReceiptIds).toHaveLength(prepared.files.length + 1);
  });
  it("derives required role and vector verification from frozen membership", async () => {
    const changed = structuredClone(prepared), fixture = publicationFixture(snapshot);
    const logo = changed.files.find(file => file.mimeType === "image/svg+xml")!;
    logo.bytes = strToU8(strFromU8(logo.bytes).replaceAll("#000000", "#FF0000"));
    logo.contentHash = hashBytes(logo.bytes); logo.role = "avatar"; logo.verification = null;
    rewriteArchive(changed, manifest => {
      const member = (manifest.files as { name: string; role: string; contentHash: string; byteLength: number }[]).find(file => file.name === logo.name)!;
      member.role = logo.role; member.contentHash = logo.contentHash; member.byteLength = logo.bytes.byteLength;
    });
    await expect(publishPreparedLogoExport(fixture.job, snapshot, changed, fixture.dependencies, new AbortController().signal)).rejects.toThrow();
    expect(fixture.storage.size).toBe(0);
  });
  it.each(["approvedLogoId", "directionApprovalId", "variantSetId", "variantReviewId", "memberHash", "memberLength", "memberMime", "memberVariant", "signedUrl", "omissions", "notices"] as const)("rejects changed public manifest %s before storage", async field => {
    const changed = structuredClone(prepared), fixture = publicationFixture(snapshot);
    rewriteArchive(changed, manifest => {
      const member = (manifest.files as { contentHash: string; byteLength: number; mimeType: string; variantId: string }[])[0]!;
      if (["approvedLogoId", "directionApprovalId", "variantSetId", "variantReviewId"].includes(field)) manifest[field] = id(999);
      else if (field === "memberHash") member.contentHash = "f".repeat(64);
      else if (field === "memberLength") member.byteLength++;
      else if (field === "memberMime") member.mimeType = "image/png";
      else if (field === "memberVariant") member.variantId = id(998);
      else if (field === "signedUrl") manifest.signedUrl = "https://example.com/private?token=synthetic-secret";
      else if (field === "omissions") manifest.licenseOmissions = [];
      else if (field === "notices") manifest.notices = ["Unverified exclusive rights claim"];
    });
    await expect(publishPreparedLogoExport(fixture.job, snapshot, changed, fixture.dependencies, new AbortController().signal)).rejects.toThrow();
    expect(fixture.storage.size).toBe(0);
  });
  it.each(["per-entry", "cumulative"] as const)("rejects ZIP %s size excess before any inflation allocation", async mode => {
    const changed = structuredClone(prepared);
    changed.archive.bytes = exaggerateZipSizes(changed.archive.bytes, mode);
    changed.archive.contentHash = hashBytes(changed.archive.bytes);
    const result = await probeArchiveAllocations(snapshot, changed);
    expect(result.rejectedAllocations).toEqual([]);
    expect(result.rejected).toBe(true);
    expect(result.storageWrites).toBe(0);
  });
  it("lost lease or corrupt readback cannot stage a manifest", async () => {
    for (const mode of ["lease", "corrupt"] as const) {
      const fixture = publicationFixture(snapshot); if (mode === "lease") fixture.loseLease(); else fixture.corruptReadback();
      await expect(publishPreparedLogoExport(fixture.job, snapshot, prepared, fixture.dependencies, new AbortController().signal)).rejects.toThrow();
      expect(fixture.counters().stages).toBe(0);
    }
  });
  it("wrong snapshot, incomplete pack and changed bytes publish no files", async () => {
    for (const mode of ["source", "membership", "bytes"] as const) {
      const changed = structuredClone(prepared), fixture = publicationFixture(snapshot);
      if (mode === "source") changed.sourceSnapshotHash = "f".repeat(64);
      if (mode === "membership") changed.files = changed.files.slice(1);
      if (mode === "bytes") changed.files[0]!.bytes[0] = 0;
      await expect(publishPreparedLogoExport(fixture.job, snapshot, changed, fixture.dependencies, new AbortController().signal)).rejects.toThrow();
      expect(fixture.storage.size).toBe(0);
    }
  });
});
