import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { captureLogoComponentLocks } from "../../../src/features/logo-vector/model/locks";
import { getLogoPathPaintedBounds } from "../../../src/features/logo-vector/model/geometry";
import { logoManualEditSchema, type LogoManualEdit } from "../../../src/domain/logo-vector";

import { textEditFixture as fixture } from "./text-edit-fixtures";

describe("actual font-backed manual text edits", () => {
  it("preserves old replacement request bodies without inserting an implicit contentKind", () => {
    const edit = { kind: "replace_outlined_lettering", componentId: "lettering", fontVersionId: randomUUID(), text: "Aster" };
    expect(logoManualEditSchema.parse(edit)).toEqual(edit);
    expect(logoManualEditSchema.parse(edit)).not.toHaveProperty("contentKind");
  });

  it("replaces only explicit outlined lettering using exact brief spelling and actual font paths", async () => {
    const f = await fixture();
    const next = await f.apply({ kind: "replace_outlined_lettering", componentId: "synthetic-lettering", text: f.brief.payload.name, fontVersionId: f.input.font.record.id });
    expect(next.components[0]).toEqual(f.original.components[0]);
    expect(next.components.map(c => c.id)).toEqual(f.original.components.map(c => c.id));
    expect(next.viewBox).toEqual(f.original.viewBox);
    const lettering = next.components[1]!;
    expect(lettering.editingKind).toBe("editable_text");
    expect(lettering).toMatchObject({ transform: f.original.components[1]!.transform, textSource: { text: "A\u0301ster", contentKind: "brand_name", font: f.input.source.font, rightsEvidenceId: f.input.source.rightsEvidenceId, shapingEngine: { id: "harfbuzzjs", version: "1.6.2" } } });
    expect(lettering.paths.length).toBeGreaterThan(1);
    expect(lettering.paths.every(path => path.fill?.color === "#111827" && path.stroke === null)).toBe(true);
    expect(lettering.paths.some(path => /[QC]/.test(path.d))).toBe(true);
    expect(Math.min(...lettering.paths.map(path => getLogoPathPaintedBounds(path)!.minX))).toBeCloseTo(85);
    expect(f.document).toEqual(f.original);
    expect(f.document.components[1]).not.toHaveProperty("textSource");
  });
  it("reshapes spacing from exact owned source while retaining paint, Unicode and all other settings", async () => {
    const f = await fixture(true), before = structuredClone(f.document.components[1]!);
    const next = await f.apply({ kind: "spacing", componentId: before.id, letterSpacing: 4, lineHeight: 1 });
    expect(next.components[0]).toEqual(f.document.components[0]);
    expect(next.components[1]).toMatchObject({ transform: before.transform, textSource: { ...f.input.source, letterSpacing: 4, lineHeight: 1 } });
    expect(next.components[1]!.paths.map(path => path.d)).not.toEqual(before.paths.map(path => path.d));
    expect(f.document.components[1]).toEqual(before);
  });
  it("changes only font provenance for a font command and keeps the actual saved text content kind", async () => {
    const f = await fixture(true), newFont = structuredClone(f.input.font);
    newFont.record.id = randomUUID(); newFont.record.asset.assetId = randomUUID(); newFont.record.asset.versionId = randomUUID(); newFont.record.rights.id = randomUUID();
    f.deps.resolveFont = async () => newFont;
    const next = await f.apply({ kind: "font", componentId: "synthetic-lettering", fontVersionId: newFont.record.id });
    expect(next.components[1]).toMatchObject({ textSource: { ...f.input.source, font: newFont.record.asset, rightsEvidenceId: newFont.record.rights.id } });
  });
  it("requires explicit initials content kind and the actual source to be a lettermark", async () => {
    const f = await fixture(), edit = { kind: "replace_outlined_lettering", componentId: "synthetic-lettering", text: "ÁS", fontVersionId: f.input.font.record.id, contentKind: "approved_initials" } as const;
    await expect(f.apply(edit)).rejects.toMatchObject({ code: "unsupported_edit" });
    f.brief.payload.logoTypes = ["wordmark", "lettermark_monogram"];
    await expect(f.apply(edit)).rejects.toMatchObject({ code: "unsupported_edit" });
    f.refinement.logoType = "lettermark_monogram";
    const next = await f.apply(edit);
    expect(next.components[1]).toMatchObject({ textSource: { text: "ÁS", contentKind: "approved_initials" } });
    expect(f.brief.payload.name).toBe("A\u0301ster");
    await expect(f.apply({ ...edit, contentKind: undefined })).rejects.toMatchObject({ code: "unsupported_edit" });
  });
  it("never relabels existing approved initials as the full brand name on font or spacing changes", async () => {
    const f = await fixture(true), component = f.document.components[1]!;
    if (component.editingKind !== "editable_text") throw Error("fixture");
    component.textSource.contentKind = "approved_initials"; f.refinement.logoType = "lettermark_monogram"; f.brief.payload.name = "Aster Studio"; f.seal();
    const next = await f.apply({ kind: "spacing", componentId: component.id, letterSpacing: 2, lineHeight: 1 });
    expect(next.components[1]).toMatchObject({ textSource: { text: f.input.source.text, contentKind: "approved_initials" } });
  });
  it("retains full-name spelling, whitespace and normalization exactly and blocks another spelling", async () => {
    const f = await fixture(true);
    for (const text of ["Áster", "Aster", " A\u0301ster", "AS"]) await expect(f.apply({ kind: "text", componentId: "synthetic-lettering", text })).rejects.toMatchObject({ code: "unsupported_edit" });
    const next = await f.apply({ kind: "text", componentId: "synthetic-lettering", text: f.brief.payload.name });
    expect(next.components[1]).toMatchObject({ textSource: { text: f.brief.payload.name, contentKind: "brand_name" } });
  });
  it.each(["geometry", "outlined_custom"] as const)("does not use normal font/text/spacing commands to fabricate a source for %s", async editingKind => {
    const f = await fixture(); f.document.components[1]!.editingKind = editingKind; f.seal();
    for (const edit of [
      { kind: "font", componentId: "synthetic-lettering", fontVersionId: f.input.font.record.id },
      { kind: "text", componentId: "synthetic-lettering", text: f.brief.payload.name },
      { kind: "spacing", componentId: "synthetic-lettering", letterSpacing: 2, lineHeight: 1 },
    ] as LogoManualEdit[]) await expect(f.apply(edit)).rejects.toMatchObject({ code: "unsupported_edit" });
    expect(f.document.components[1]).not.toHaveProperty("textSource");
  });
  it.each(["whole_artwork", "illustration", "symbol", "border"] as const)("rejects explicit replacement of %s so fused artwork remains intact", async role => {
    const f = await fixture(); f.document.components[1]!.role = role; f.seal();
    await expect(f.apply({ kind: "replace_outlined_lettering", componentId: "synthetic-lettering", fontVersionId: f.input.font.record.id, text: f.brief.payload.name })).rejects.toMatchObject({ code: "unsupported_edit" });
  });
  it("rejects mixed paints instead of silently recoloring custom lettering", async () => {
    const f = await fixture(); f.document.components[1]!.paths.push({ ...f.document.components[1]!.paths[0]!, id: "another-letter", fill: { color: "#FFFFFF", opacity: 1 } }); f.seal();
    await expect(f.apply({ kind: "replace_outlined_lettering", componentId: "synthetic-lettering", fontVersionId: f.input.font.record.id, text: f.brief.payload.name })).rejects.toMatchObject({ code: "unsupported_edit" });
  });
  it("rejects a locked text component before resolving fonts", async () => {
    const f = await fixture(); f.revision.locks = [...captureLogoComponentLocks(f.document, ["synthetic-lettering"])];
    f.deps.resolveFont = async () => { throw new Error("A locked edit must not resolve a font"); };
    await expect(f.apply({ kind: "replace_outlined_lettering", componentId: "synthetic-lettering", fontVersionId: f.input.font.record.id, text: f.brief.payload.name })).rejects.toMatchObject({ code: "locked_component_changed" });
  });
  it.each(["brief-owner", "brief-id", "brief-revision", "raster-owner", "raster-preview", "font-owner", "font-project", "font-id", "document"])("rejects mismatched immutable %s evidence", async failure => {
    const f = await fixture();
    if (failure === "brief-owner") f.brief.ownerId = randomUUID();
    if (failure === "brief-id") f.brief.id = randomUUID();
    if (failure === "brief-revision") { f.brief.revision = 2; f.brief.parentRevisionId = randomUUID(); }
    if (failure === "raster-owner") { f.refinement.ownerId = randomUUID(); f.refinement.preview!.reference.ownerId = f.refinement.ownerId; }
    if (failure === "raster-preview") f.refinement.preview!.reference = { ...f.refinement.preview!.reference, assetId: randomUUID() };
    if (failure === "font-owner") f.input.font.record.asset.ownerId = randomUUID();
    if (failure === "font-project") f.input.font.record.asset.projectId = randomUUID();
    const expectedFontId = f.input.font.record.id;
    if (failure === "font-id") f.input.font.record.id = randomUUID();
    if (failure === "document") f.document.components[0]!.paths[0]!.fill!.color = "#333333";
    await expect(f.apply({ kind: "replace_outlined_lettering", componentId: "synthetic-lettering", fontVersionId: expectedFontId, text: "A\u0301ster" })).rejects.toMatchObject({ code: "source_mismatch" });
  });
  it("requires an exact owned font-and-rights match for existing text", async () => {
    const f = await fixture(true); f.deps.listFonts = async () => [];
    await expect(f.apply({ kind: "spacing", componentId: "synthetic-lettering", letterSpacing: 2, lineHeight: 1 })).rejects.toMatchObject({ code: "font_rights_required" });
  });
  it("never falls back when outline rights are unknown", async () => {
    const f = await fixture(); f.input.font.record.rights.permissions.outline = "unknown";
    await expect(f.apply({ kind: "replace_outlined_lettering", componentId: "synthetic-lettering", fontVersionId: f.input.font.record.id, text: f.brief.payload.name })).rejects.toMatchObject({ code: "font_rights_required" });
  });
  it("checks cancellation again after an awaited font lookup", async () => {
    const f = await fixture(), controller = new AbortController();
    f.deps.resolveFont = async () => { controller.abort(); return f.input.font; };
    await expect(f.apply({ kind: "replace_outlined_lettering", componentId: "synthetic-lettering", fontVersionId: f.input.font.record.id, text: f.brief.payload.name }, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });

  it("preserves the painted anchor and stroke widths when reshaping existing stroked lettering", async () => {
    const f = await fixture(true), component = f.document.components[1]!;
    component.paths.forEach(path => { path.stroke = { color: "#D122AA", width: 2, opacity: 0.75, linecap: "round", linejoin: "round", miterLimit: 4 }; }); f.seal();
    const before = component.paths.map(getLogoPathPaintedBounds).filter(item => item !== null);
    const next = await f.apply({ kind: "spacing", componentId: component.id, letterSpacing: 3, lineHeight: 1 });
    const after = next.components[1]!.paths.map(getLogoPathPaintedBounds).filter(item => item !== null);
    expect(Math.min(...after.map(item => item.minX))).toBeCloseTo(Math.min(...before.map(item => item.minX)));
    expect(Math.min(...after.map(item => item.minY))).toBeCloseTo(Math.min(...before.map(item => item.minY)));
    expect(next.components[1]!.paths.every(path => path.stroke?.width === 2 && path.stroke.opacity === .75 && path.stroke.color === "#D122AA")).toBe(true);
  });
  it("rejects text growth that would occlude a different locked component", async () => {
    const f = await fixture(true), target = f.document.components[1]!;
    f.document.components[0]!.transform = { x: 200, y: 80, scale: 1, rotation: 0 }; f.seal();
    f.revision.locks = [...captureLogoComponentLocks(f.document, ["synthetic-symbol"])];
    await expect(f.apply({ kind: "spacing", componentId: target.id, letterSpacing: 50, lineHeight: 1 })).rejects.toMatchObject({ code: "locked_component_changed" });
  });

  it("returns a typed limit failure when uniform fitting needs an oversized font size", async () => {
    const f = await fixture(); f.document.viewBox = [0, 0, 16_384, 16_384];
    f.document.components[1]!.paths = [{ ...f.document.components[1]!.paths[0]!, d: "M80 80L16380 80L16380 16380L80 16380Z" }];
    f.brief.payload.name = "A"; f.seal();
    await expect(f.apply({ kind: "replace_outlined_lettering", componentId: "synthetic-lettering", fontVersionId: f.input.font.record.id, text: "A" })).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(f.document.components[1]).not.toHaveProperty("textSource");
  });

  it("rejects line-height changes rather than saving an ineffective single-line version", async () => {
    const f = await fixture(true);
    await expect(f.apply({ kind: "spacing", componentId: "synthetic-lettering", letterSpacing: 0, lineHeight: 1.5 })).rejects.toMatchObject({ code: "unsupported_edit" });
  });

});
