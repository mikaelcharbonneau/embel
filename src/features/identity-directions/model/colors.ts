import { colorSpecificationSchema, type ColorSpecification } from "@/domain/logo-directions";
import { logoIdentifierSchema } from "@/domain/logo-vector";

/** Reviewed server receipts. This helper neither performs conversion nor fetches sources. */
export type ColorConversionEvidence = {
  icc: null | { sourceHex: string; channels: readonly [number, number, number, number]; profileId: string; profileHash: string; conversionVersion: string; limitations: readonly string[] };
  pantone: null | { sourceHex: string; reference: string; sourceId: string; sourceHash: string; rightsEvidenceId: string; limitations: readonly string[] };
};

export function describeColor(hex: string, evidence: ColorConversionEvidence): ColorSpecification {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new TypeError("A color must use six-digit HEX.");
  const normalized = hex.toUpperCase();
  for (const receipt of [evidence.icc, evidence.pantone]) {
    if (receipt && (!/^#[0-9a-f]{6}$/i.test(receipt.sourceHex) || receipt.sourceHex.toUpperCase() !== normalized)) {
      throw new TypeError("The print reference belongs to a different source color.");
    }
  }
  if (evidence.pantone) logoIdentifierSchema.parse(evidence.pantone.rightsEvidenceId);
  return colorSpecificationSchema.parse({
    hex: normalized,
    rgb: [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)],
    cmyk: evidence.icc ? { status: "converted", channels: [...evidence.icc.channels], profileId: evidence.icc.profileId, profileHash: evidence.icc.profileHash,
      conversionVersion: evidence.icc.conversionVersion, limitations: [...evidence.icc.limitations] } : { status: "unavailable", reason: "profile_unavailable" },
    pantone: evidence.pantone ? { status: "approximate", reference: evidence.pantone.reference, sourceId: evidence.pantone.sourceId,
      sourceHash: evidence.pantone.sourceHash, limitations: [...evidence.pantone.limitations] } : { status: "unavailable", reason: "licensed_source_unavailable" },
  });
}
