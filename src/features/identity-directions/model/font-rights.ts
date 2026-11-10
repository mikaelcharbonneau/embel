import { fontRecordSchema, type FontRecord, type FontPurpose } from "@/domain/logo-directions";

/** Permission labels do not replace byte/license verification by the resolver. */
export function fontPurposeAllowed(record: FontRecord, purpose: FontPurpose): boolean {
  const parsed = fontRecordSchema.safeParse(record);
  return (
    parsed.success &&
    parsed.data.rights.sourceKind === "reviewed_license" &&
    parsed.data.rights.reviewedAt !== null &&
    parsed.data.rights.commercialUse === "allowed" &&
    parsed.data.rights.permissions[purpose] === "allowed"
  );
}
