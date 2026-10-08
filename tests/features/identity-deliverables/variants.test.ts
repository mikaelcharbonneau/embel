import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import * as variants from "../../../src/features/identity-deliverables/model/variants";
import { deliverableFixture, resolvedFixture, syntheticDocument, types } from "./fixtures";

describe("synthetic variants: actual geometry and review boundary", () => {
  it("provides approved variant production", () => expect(variants.proposeLogoVariants).toBeTypeOf("function"));
  it.each(types)("retains a usable primary in all three colorways for %s", type => {
    const input = deliverableFixture(type), before = JSON.stringify(input);
    const proposed = variants.proposeLogoVariants(input);
    expect(proposed.items.filter(v => v.role === "primary").map(v => v.colorway)).toEqual(["black", "white", "color"]);
    expect(proposed.items.filter(v => v.role === "primary").every(v => v.document?.components.length)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    expect(proposed.items.every(v => !("id" in v) && !("preview" in v) && !("renderHash" in v))).toBe(true);
  });
  it("wordmark_has_no_invented_symbol_variant", () => {
    expect(variants.proposeLogoVariants(deliverableFixture("wordmark")).items.find(v => v.role === "symbol_only")?.applicability).toEqual({ status: "not_applicable", reason: "no_symbol" });
  });
  it.each(["emblem", "mascot"] as const)("does not mechanically rearrange inseparable %s", type => {
    expect(variants.proposeLogoVariants(deliverableFixture(type)).items.filter(v => ["horizontal", "stacked"].includes(v.role)).every(v => v.applicability.status === "not_applicable")).toBe(true);
  });
  it("requires exact approvals before even proposing files", () => {
    const input = deliverableFixture(); input.logoApproval.vectorRevisionId = input.projectId;
    expect(() => variants.proposeLogoVariants(input)).toThrow(/approved/i);
  });
  it("review_validation_requires_resolved_verified_document", () => {
    const { resolved, review } = resolvedFixture(syntheticDocument(), variants.computeLogoVariantRenderHash);
    expect(variants.validateVariantReview(resolved, review)).toHaveLength(3);
    resolved.items[0]!.document = null;
    expect(() => variants.validateVariantReview(resolved, review)).toThrow(/review/i);
  });
  it("changed geometry, palette, spacing or preview policy invalidates review", () => {
    for (const change of ["geometry", "palette", "spacing", "hash"] as const) {
      const { resolved, review } = resolvedFixture(syntheticDocument(), variants.computeLogoVariantRenderHash);
      const item = resolved.items[0]!;
      if (change === "geometry") item.document!.components[0]!.transform.x += 1;
      if (change === "palette") item.document!.components[0]!.paths[0]!.fill!.color = "#ABCDEF";
      if (change === "spacing") item.variant.clearSpace += 1;
      if (change === "hash") item.variant.renderHash = "f".repeat(64);
      expect(() => variants.validateVariantReview(resolved, review)).toThrow();
    }
  });
  it("rejects a document file hash that does not bind the resolved canonical bytes", () => {
    const { resolved, review } = resolvedFixture(syntheticDocument(), variants.computeLogoVariantRenderHash);
    resolved.items[0]!.variant.documentAsset!.contentHash = "0".repeat(64);
    expect(() => variants.validateVariantReview(resolved, review)).toThrow();
  });
  it("preview renders actual draft PNG without final review", async () => {
    const proposal = variants.proposeLogoVariants(deliverableFixture()).items[0]!;
    const preview = await variants.renderProposedVariantPreview(proposal, new AbortController().signal);
    expect(preview?.png.slice(0, 8)).toEqual(new Uint8Array([137,80,78,71,13,10,26,10]));
    expect(new TextDecoder().decode(preview?.svg)).toContain("<path");
    expect(preview?.renderHash).toBe(variants.computeLogoVariantRenderHash(proposal, proposal.document!));
    expect(preview).not.toHaveProperty("approval");
  });
  it("nonapplicable and aborted previews cannot produce files", async () => {
    const proposals = variants.proposeLogoVariants(deliverableFixture("wordmark")).items;
    expect(await variants.renderProposedVariantPreview(proposals.find(v => v.role === "symbol_only")!, new AbortController().signal)).toBeNull();
    const aborted = AbortSignal.abort();
    await expect(variants.renderProposedVariantPreview(proposals[0]!, aborted)).rejects.toThrow();
  });
});
