import type { LogoFileVerification } from "./verify-output";
export type PreparedExportFile = { name: string; role: string; mimeType: string; bytes: Uint8Array; contentHash: string; sourceVariantId: string | null; verification: LogoFileVerification | null };
export type PreparedLogoExport = { files: readonly PreparedExportFile[]; archive: PreparedExportFile; licenseOmissions: readonly { fontVersionId: string; reason: string }[]; sourceSnapshotHash: string };
/** Carries earlier verified bytes for the caller; this is not a durable publication or a ready pack. */
export class LogoExportPreparationError extends Error {
  constructor(public readonly code: "file_failed" | "package_too_large", public readonly files: readonly PreparedExportFile[], options?: ErrorOptions) {
    super(code === "package_too_large" ? "The logo pack exceeds 50 MiB. Choose smaller PNG dimensions or download verified files individually." : "The required logo pack is incomplete. Some individual files were verified.", options);
    this.name = "LogoExportPreparationError";
  }
}

export type ExportPublicationFile = Pick<PreparedExportFile, "name" | "role" | "mimeType" | "contentHash" | "sourceVariantId"> & { byteLength: number };
/** Metadata travels only on the trusted producer/SQL boundary, never from an HTTP body. */
export type ExportPublicationDetails = { completeness: "complete"; failure: null; files: readonly ExportPublicationFile[] } | { completeness: "partial"; failure: "file_failed" | "package_too_large"; files: readonly ExportPublicationFile[] };
