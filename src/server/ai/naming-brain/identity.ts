import "server-only";
import { createHash } from "node:crypto";

export function canonicalNamingJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalNamingJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalNamingJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw new Error("invalid_naming_json");
}
export const namingHash = (value: unknown): string => createHash("sha256").update(canonicalNamingJson(value)).digest("hex");
export const namingTextHash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
export function namingStableId(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
