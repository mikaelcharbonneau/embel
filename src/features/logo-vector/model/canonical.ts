import type { LogoVectorDocument } from "../../../domain/logo-vector";
import { LogoVectorError } from "./errors";
import { validateLogoVectorDocument } from "./geometry";
import { VECTOR_LIMITS } from "./limits";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** One browser/server encoder: sorted object keys, original array/paint order. */
export function canonicalLogoDocumentBytes(document: LogoVectorDocument): Uint8Array {
  const bytes = new TextEncoder().encode(canonical(validateLogoVectorDocument(document)));
  if (bytes.byteLength > VECTOR_LIMITS.bytes) throw new LogoVectorError("limit_exceeded", "Canonical vector document exceeds the 8 MiB limit.");
  return bytes;
}
