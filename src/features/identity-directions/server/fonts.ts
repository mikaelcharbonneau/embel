import "server-only";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import nodeModule from "node:module";
import path from "node:path";
import type { ClaimedJob } from "@/domain/jobs";
import {
  fontPurposeSchema,
  fontRecordSchema,
  fontRightsEvidenceSchema,
  type FontPurpose,
  type FontRecord,
  type FontRightsEvidence,
  type PermittedFont,
} from "@/domain/logo-directions";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";
import { readLogoFontRecord } from "@/server/data/logo-workspace";
import { logoId, logoOwner } from "@/server/data/logo-transaction";
import { productionIdentityAssetStore, type IdentityAssetStore } from "@/server/data/identity-asset-store";
import { fontPurposeAllowed } from "../model/font-rights";
import { canonicalIdentityInput } from "../model/font-check-binding";
import { inspectFontBytes } from "./font-inspection";
import catalog from "../catalog/free-fonts.json";

export type FontLicenseDocument = { licenseText: string; sourceUrl: string };
export type FreeCatalogFont = {
  id: string;
  family: string;
  rights: FontRightsEvidence;
  conditions: readonly string[];
  reservedFontNames: readonly string[];
};
export type CatalogFontBytes = FreeCatalogFont & {
  bytes: Uint8Array;
  contentHash: string;
  mimeType: "font/ttf";
  licenseText: string;
};
const requireHere = nodeModule.createRequire(path.join(process.cwd(), "package.json")),
  hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const allowed = {
  render: "allowed",
  outline: "allowed",
  embed: "allowed",
  modify: "allowed",
  redistribute: "allowed",
} as const;
const active = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new ApiError("integration_unavailable");
};
function catalogMetadata(entry: (typeof catalog.entries)[number]): FreeCatalogFont {
  return {
    id: entry.id,
    family: entry.family,
    rights: fontRightsEvidenceSchema.parse({
      id: entry.rightsEvidenceId,
      fontContentHash: entry.contentHash,
      sourceKind: "reviewed_license",
      sourceUrl: entry.licenseSourceUrl,
      licenseTextHash: entry.licenseTextHash,
      commercialUse: "allowed",
      permissions: allowed,
      reviewedAt: entry.reviewedAt,
    }),
    conditions: entry.conditions,
    reservedFontNames: entry.reservedFontNames,
  };
}
/** These are reviewed source files, not owned records. Import must use the shared store. */
export async function readFreeCatalogFont(catalogId: string): Promise<CatalogFontBytes> {
  const entry = catalog.entries.find((item) => item.id === catalogId);
  if (!entry) throw new ApiError("not_found");
  const root = path.dirname(path.dirname(requireHere.resolve("geist/font/sans"))),
    packagePath = path.join(root, "package.json");
  const version = JSON.parse(await readFile(packagePath, "utf8")) as { version?: string };
  if (version.version !== entry.packageVersion) throw new ApiError("integration_unavailable");
  const [file, licenseText] = await Promise.all([
    readFile(path.join(root, "dist/fonts", entry.file)),
    readFile(path.join(root, "LICENSE.txt"), "utf8"),
  ]);
  if (hash(file) !== entry.contentHash || hash(licenseText) !== entry.licenseTextHash) throw new ApiError("not_found");
  return {
    ...catalogMetadata(entry),
    bytes: new Uint8Array(file),
    contentHash: entry.contentHash,
    mimeType: "font/ttf",
    licenseText,
  };
}
export async function listFreeFontCatalog(): Promise<readonly FreeCatalogFont[]> {
  // Verify installed bytes before advertising an available reviewed catalog entry.
  return Promise.all(
    catalog.entries.map(async (entry) => {
      await readFreeCatalogFont(entry.id);
      return catalogMetadata(entry);
    }),
  );
}
async function catalogLicense(record: FontRecord): Promise<FontLicenseDocument> {
  if (record.source !== "free_catalog") throw new ApiError("integration_unavailable");
  const entry = catalog.entries.find(
    (item) =>
      item.contentHash === record.asset.contentHash &&
      item.licenseTextHash === record.rights.licenseTextHash &&
      item.licenseSourceUrl === record.rights.sourceUrl,
  );
  if (!entry) throw new ApiError("not_found");
  const font = await readFreeCatalogFont(entry.id);
  return { licenseText: font.licenseText, sourceUrl: font.rights.sourceUrl! };
}
export type FontResolverDependencies = {
  loadRecord(auth: AuthenticatedContext, fontVersionId: string, signal?: AbortSignal): Promise<FontRecord>;
  store: IdentityAssetStore;
  /** The actual immutable uploaded license text, resolved server-side, never browser flags. */
  loadRightsEvidence?(record: FontRecord, signal?: AbortSignal): Promise<FontLicenseDocument>;
};
async function checkFont(
  record: FontRecord,
  bytes: Uint8Array,
  mimeType: string,
  purpose: FontPurpose,
  license: FontLicenseDocument,
  signal?: AbortSignal,
): Promise<PermittedFont> {
  active(signal);
  // Buffer.slice() aliases storage-owned memory; inspection and return require a real snapshot.
  bytes = Uint8Array.from(bytes);
  if (!fontPurposeAllowed(record, purpose)) throw new ApiError("integration_unavailable");
  if (new TextEncoder().encode(license.licenseText).byteLength > 262_144 || !license.licenseText.trim())
    throw new ApiError("not_found");
  if (
    hash(bytes) !== record.asset.contentHash ||
    hash(license.licenseText) !== record.rights.licenseTextHash ||
    license.sourceUrl !== record.rights.sourceUrl
  )
    throw new ApiError("not_found");
  if (
    record.source === "free_catalog" &&
    !catalog.entries.some(
      (entry) =>
        entry.contentHash === record.asset.contentHash &&
        entry.licenseTextHash === record.rights.licenseTextHash &&
        entry.licenseSourceUrl === license.sourceUrl &&
        entry.family === record.family,
    )
  )
    throw new ApiError("not_found");
  const metadata = await inspectFontBytes(bytes, mimeType, signal);
  if (metadata.family !== record.family) throw new ApiError("not_found");
  active(signal);
  return { record, bytes: Uint8Array.from(bytes), contentHash: record.asset.contentHash, purpose };
}
export function createFontResolver(dependencies: FontResolverDependencies) {
  return async (
    auth: AuthenticatedContext,
    fontVersionId: string,
    purpose: FontPurpose,
    signal?: AbortSignal,
  ): Promise<PermittedFont> => {
    const owner = logoOwner(auth),
      id = logoId(fontVersionId);
    fontPurposeSchema.parse(purpose);
    active(signal);
    const parsed = fontRecordSchema.safeParse(await dependencies.loadRecord(auth, id, signal));
    if (!parsed.success || parsed.data.id !== id || parsed.data.asset.ownerId !== owner)
      throw new ApiError("not_found");
    const record = parsed.data;
    if (!fontPurposeAllowed(record, purpose)) throw new ApiError("integration_unavailable");
    const [asset, license] = await Promise.all([
      dependencies.store.readOwnedAsset(auth, record.asset, signal),
      (dependencies.loadRightsEvidence ?? catalogLicense)(record, signal),
    ]);
    if (
      canonicalIdentityInput(asset.reference) !== canonicalIdentityInput(record.asset) ||
      asset.verification.contentHash !== record.asset.contentHash ||
      asset.verification.mimeType !== asset.mimeType ||
      asset.verification.byteLength !== asset.bytes.byteLength
    )
      throw new ApiError("not_found");
    return checkFont(record, asset.bytes, asset.mimeType, purpose, license, signal);
  };
}
export const resolvePermittedFont = createFontResolver({
  loadRecord: readLogoFontRecord,
  store: productionIdentityAssetStore,
});
export type LeasedFontResolverDependencies = {
  /** Must use the shared lease-fenced immutable loader. A caller-provided font is insufficient. */
  loadRecords(job: ClaimedJob, signal: AbortSignal): Promise<readonly FontRecord[]>;
  loadRightsEvidence?(record: FontRecord, signal?: AbortSignal): Promise<FontLicenseDocument>;
};
export function createLeasedFontResolver(dependencies: LeasedFontResolverDependencies) {
  return async (
    job: ClaimedJob,
    input: FontRecord,
    purpose: FontPurpose,
    store: IdentityAssetStore,
    signal: AbortSignal,
  ): Promise<PermittedFont> => {
    active(signal);
    logoId(job.id);
    logoId(job.leaseToken);
    fontPurposeSchema.parse(purpose);
    const parsed = fontRecordSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.asset.ownerId !== job.ownerId ||
      parsed.data.asset.projectId !== job.projectId ||
      !["running", "partial"].includes(job.status)
    )
      throw new ApiError("not_found");
    const record = parsed.data,
      records = await dependencies.loadRecords(job, signal);
    const matches = records.filter((item) => item.id === record.id);
    if (matches.length !== 1 || canonicalIdentityInput(matches[0]) !== canonicalIdentityInput(record))
      throw new ApiError("not_found");
    if (!fontPurposeAllowed(record, purpose)) throw new ApiError("integration_unavailable");
    const [asset, license] = await Promise.all([
      store.readLeasedAsset(job, record.asset, signal),
      (dependencies.loadRightsEvidence ?? catalogLicense)(record, signal),
    ]);
    if (
      canonicalIdentityInput(asset.reference) !== canonicalIdentityInput(record.asset) ||
      asset.verification.contentHash !== record.asset.contentHash ||
      asset.verification.mimeType !== asset.mimeType ||
      asset.verification.byteLength !== asset.bytes.byteLength
    )
      throw new ApiError("not_found");
    return checkFont(record, asset.bytes, asset.mimeType, purpose, license, signal);
  };
}
/** Uploaded declarations remain unreviewed; known family names never promote them. */
export function describeUploadedFontRights(input: {
  id: string;
  fontContentHash: string;
  licenseText: string;
  sourceUrl: string | null;
}): FontRightsEvidence {
  if (!input.licenseText.trim() || new TextEncoder().encode(input.licenseText).byteLength > 262_144)
    throw new TypeError("Attach the actual font license text.");
  return fontRightsEvidenceSchema.parse({
    id: input.id,
    fontContentHash: input.fontContentHash,
    sourceKind: "user_declaration",
    sourceUrl: input.sourceUrl,
    licenseTextHash: hash(input.licenseText),
    commercialUse: "unknown",
    permissions: {
      render: "unknown",
      outline: "unknown",
      embed: "unknown",
      modify: "unknown",
      redistribute: "unknown",
    },
    reviewedAt: null,
  });
}
