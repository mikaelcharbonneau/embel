import "server-only";
import { unzipSync } from "fflate";
import type { IdentityAssetWrite } from "../../../server/data/identity-asset-store";
import { assertFileBytes, LOGO_MAX_FILE_BYTES, sha256, LogoFileError } from "./render-policy";
import { runLogoProcess } from "./process";
/** Bounded passive ZIP inspection, before inflating potentially untrusted members. */
function inspectLogoExportArchive(input: Uint8Array): Record<string, Uint8Array> {
  assertFileBytes(input);
  // Both passes inspect the same private copy, including for Buffer/SAB callers.
  const bytes = new Uint8Array(input),
    expectedSizes = new Map<string, number>();
  let total = 0;
  // Returning false makes fflate inspect central-directory metadata without
  // allocating or inflating a single entry. Validate the WHOLE archive first.
  unzipSync(bytes, {
    filter(file) {
      if (
        file.name.length > 200 ||
        !/^[A-Za-z0-9._-]+$/.test(file.name) ||
        file.name === "." ||
        file.name === ".." ||
        expectedSizes.has(file.name) ||
        expectedSizes.size >= 100 ||
        !Number.isSafeInteger(file.originalSize) ||
        file.originalSize < 0 ||
        file.originalSize > LOGO_MAX_FILE_BYTES ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > bytes.byteLength ||
        ![0, 8].includes(file.compression) ||
        (file.compression === 0 && file.size !== file.originalSize)
      )
        throw new LogoFileError("verification_failed", "The archive contains an unsafe, duplicate or oversized entry.");
      expectedSizes.set(file.name, file.originalSize);
      total += file.originalSize;
      if (total > LOGO_MAX_FILE_BYTES * 4)
        throw new LogoFileError("size_limit", "The archive exceeds the unpacked byte limit.");
      return false;
    },
  });
  if (!expectedSizes.size) throw new LogoFileError("verification_failed", "The export archive is empty.");
  const files = unzipSync(bytes);
  if (
    Object.keys(files).length !== expectedSizes.size ||
    [...expectedSizes].some(([name, size]) => !files[name] || files[name].byteLength !== size)
  )
    throw new LogoFileError("verification_failed", "The archive entry sizes do not match the validated directory.");
  return files;
}
/** Storage injection for PDF/ZIP export files. Other MIME branches remain P1/P4-owned. */
export async function validateLogoExportAssetBytes(
  write: IdentityAssetWrite,
  input: Uint8Array,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  assertFileBytes(input);
  const bytes = new Uint8Array(input);
  if (
    write.kind !== "stage" ||
    write.publication.source.kind !== "export" ||
    sha256(bytes) !== write.publication.contentHash ||
    bytes.byteLength !== write.publication.byteLength
  )
    throw new LogoFileError("verification_failed", "Only an exact staged export may use this validator.");
  if (write.publication.mimeType === "application/pdf")
    await runLogoProcess({ operation: "inspect_pdf", pdf: bytes }, signal);
  else if (write.publication.mimeType === "application/zip") inspectLogoExportArchive(bytes);
  else throw new LogoFileError("invalid_options", "This export validator handles PDF and ZIP only.");
}
