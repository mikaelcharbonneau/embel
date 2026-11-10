import {
  logoVectorRevisionSchema,
  type LogoVectorDocument,
  type LogoVectorRevision,
} from "../../../domain/logo-vector";
import { canonicalLogoDocumentBytes } from "../model/canonical";
import { validateLogoVectorDocument } from "../model/geometry";
import { serializeLogoSvg } from "../model/svg";
import { LogoVectorError } from "../model/errors";

const mismatch = (): never => {
  throw new LogoVectorError(
    "source_mismatch",
    "The displayed vector does not match its exact immutable document and SVG proof.",
  );
};
const digest = async (bytes: Uint8Array): Promise<string> => {
  const result = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
/** A valid-looking document is not enough. Reconstruct both authoritative byte
 * encodings before any preview or acceptance control can receive the document.
 * Snapshot validated data before hashing; check the account/abort fence after
 * each asynchronous digest, including delayed failures. */
export async function verifyLogoVectorDetailHashes(
  input: { revision: LogoVectorRevision; document: LogoVectorDocument },
  active: () => boolean,
): Promise<LogoVectorDocument | null> {
  if (!active()) return null;
  try {
    const revision = logoVectorRevisionSchema.parse(input.revision),
      document = validateLogoVectorDocument(input.document);
    const documentBytes = canonicalLogoDocumentBytes(document),
      svgBytes = serializeLogoSvg(document);
    const documentHash = await digest(documentBytes);
    if (!active()) return null;
    const svgHash = await digest(svgBytes);
    if (!active()) return null;
    const proof = revision.proof;
    if (
      documentHash !== revision.documentHash ||
      documentHash !== revision.documentAsset.contentHash ||
      documentHash !== proof.documentHash ||
      svgHash !== revision.svgAsset.contentHash ||
      svgHash !== proof.svgContentHash ||
      proof.validator.id !== "fluid.logo-vector" ||
      proof.validator.version !== "1" ||
      proof.viewBox.some((value, index) => value !== document.viewBox[index]) ||
      proof.componentCount !== document.components.length ||
      proof.pathCount !== document.components.reduce((count, component) => count + component.paths.length, 0) ||
      proof.externalFontDependencies.length !== 0
    )
      return mismatch();
    return document;
  } catch (error) {
    if (!active()) return null;
    throw error;
  }
}
