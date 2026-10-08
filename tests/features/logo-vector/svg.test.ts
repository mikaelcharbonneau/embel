import { afterEach, describe, expect, it, vi } from "vitest";
import { validateLogoVectorSvg, serializeLogoSvg } from "../../../src/features/logo-vector/model/svg";
import { flattenLogoPaths } from "../../../src/features/logo-vector/model/geometry";
import { VECTOR_LIMITS } from "../../../src/features/logo-vector/model/limits";
const bytes = (text: string) => new TextEncoder().encode(text);
const svg = (body: string, root = 'viewBox="0 0 100 100"') => bytes(`<svg xmlns="http://www.w3.org/2000/svg" ${root}>${body}</svg>`);
const triangle = '<path d="M20 20L40 20L30 40Z"/>';
afterEach(() => vi.unstubAllGlobals());

describe("safe canonical SVG", () => {
  it("roundtrips cubic strokes, alpha, shorthand and a compound hole through canonical geometry", () => {
    const document = validateLogoVectorSvg(svg('<title>Original &amp; synthetic</title><g transform="translate(5 5) scale(1.2)" fill="#123456" fill-opacity="0.6"><path id="drawing" fill-rule="evenodd" d="m10 10h40v40h-40z m10 10v20h20v-20z"/><path d="M10 60c10 -20 20 -20 30 0s20 20 30 0" fill="none" stroke="#000" stroke-width="2" stroke-opacity="0.5" stroke-linecap="round" stroke-linejoin="round"/></g>'));
    const portable = serializeLogoSvg(document);
    const reread = validateLogoVectorSvg(portable);
    expect(flattenLogoPaths(reread)).toEqual(flattenLogoPaths(document));
    expect(new TextDecoder().decode(portable)).not.toContain("<image");
    expect(reread.components[0]!.paths[0]!.fillRule).toBe("evenodd");
    expect(reread.components[0]!.paths[1]!.stroke!.width).toBe(2.4);
  });
  it("derives a viewBox only from finite positive px or unitless dimensions", () => {
    expect(validateLogoVectorSvg(svg(triangle, 'width="100px" height="100"')).viewBox).toEqual([0, 0, 100, 100]);
    expect(() => validateLogoVectorSvg(svg(triangle, 'width="100%" height="100"'))).toThrowError(expect.objectContaining({code:"unsupported_svg"}));
  });
  const hostile = [
    '<image href="data:image/png;base64,AA=="/>', '<script>alert(1)</script>',
    '<path onload="alert(1)" d="M20 20L40 20L30 40Z"/>', '<foreignObject/>', '<use href="#other"/>',
    '<path href="https://example.invalid/logo" d="M20 20L40 20L30 40Z"/>',
    '<path style="fill:url(https://example.invalid/paint)" d="M20 20L40 20L30 40Z"/>',
    '<filter/>', '<mask/>', '<linearGradient/>', '<clipPath/>', '<g opacity="0.5">'+triangle+'</g>',
    '<text>Brand</text>', '<path fill="url(#paint)" d="M20 20L40 20L30 40Z"/>',
    '<g display="none">'+triangle+'</g>', '<g visibility="hidden">'+triangle+'</g>',
    '<path xmlns="http://example.invalid/foreign" d="M20 20L40 20L30 40Z"/>',
    '<g>'+triangle, '<path id="same" d="M20 20L40 20L30 40Z"/><path id="same" d="M50 50L60 50L55 60Z"/>',
  ];
  it.each(hostile)("rejects unsupported or misleading input without any network call: %s", body => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(() => validateLogoVectorSvg(svg(body))).toThrowError(expect.objectContaining({code:"unsupported_svg"}));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects DOCTYPE/entities and invalid UTF-8 before canonical output", () => {
    expect(() => validateLogoVectorSvg(bytes('<!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>&x;</title>'+triangle+'</svg>'))).toThrowError(expect.objectContaining({code:"unsupported_svg"}));
    expect(() => validateLogoVectorSvg(new Uint8Array([0xc0,0xaf]))).toThrowError(expect.objectContaining({code:"unsupported_svg"}));
  });
  it.each(['M20 20', 'M20 20L40 40', 'M20 20L40 20L30 40Z M20 20L40 20L30 40Z'])("requires visible ink, including even-odd cancellation: %s", d => {
    expect(() => validateLogoVectorSvg(svg(`<path fill-rule="evenodd" d="${d}"/>`))).toThrowError(expect.objectContaining({code:"empty_artwork"}));
  });
  it("rejects transparency, clipping, invalid extents and nonfinite coordinates", () => {
    expect(() => validateLogoVectorSvg(svg('<path opacity="1" fill-opacity="0" d="M20 20L40 20L30 40Z"/>'))).toThrowError(expect.objectContaining({code:"empty_artwork"}));
    for (const d of ['M200 200L240 200L220 240Z','M-10 20L40 20L30 40Z','M1e309 20L40 20L30 40Z']) expect(() => validateLogoVectorSvg(svg(`<path d="${d}"/>`))).toThrowError(expect.objectContaining({code:"invalid_geometry"}));
    for (const box of ['0 0 0 100','0 0 -1 100','0 0 16385 100']) expect(() => validateLogoVectorSvg(svg(triangle,`viewBox="${box}"`))).toThrowError(expect.objectContaining({code:"invalid_geometry"}));
  });
  it("allows affine fill transforms but rejects nonuniform stroked transforms and unsupported arcs", () => {
    expect(validateLogoVectorSvg(svg('<g transform="matrix(1 .2 .1 1 0 0)">'+triangle+'</g>')).components).toHaveLength(1);
    expect(() => validateLogoVectorSvg(svg('<g transform="scale(2 1)"><path stroke="#000" d="M20 20L40 20L30 40Z"/></g>'))).toThrowError(expect.objectContaining({code:"unsupported_svg"}));
    expect(() => validateLogoVectorSvg(svg('<path d="M20 20A10 10 0 0 0 40 20Z"/>'))).toThrowError(expect.objectContaining({code:"unsupported_svg"}));
  });
  it("checks exact XML depth and path count ceilings during parsing", () => {
    expect(validateLogoVectorSvg(svg('<g>'.repeat(14)+triangle+'</g>'.repeat(14))).components).toHaveLength(1);
    expect(() => validateLogoVectorSvg(svg('<g>'.repeat(15)+triangle+'</g>'.repeat(15)))).toThrowError(expect.objectContaining({code:"limit_exceeded"}));
    expect(validateLogoVectorSvg(svg(triangle.repeat(VECTOR_LIMITS.paths))).components[0]!.paths).toHaveLength(VECTOR_LIMITS.paths);
    expect(() => validateLogoVectorSvg(svg(triangle.repeat(VECTOR_LIMITS.paths+1)))).toThrowError(expect.objectContaining({code:"limit_exceeded"}));
  });
  it("checks command and UTF-8 byte ceiling pairs", () => {
    const atLimit = 'M20 20'+'L20 20'.repeat(VECTOR_LIMITS.commands-4)+'L40 20L30 40Z';
    expect(validateLogoVectorSvg(svg(`<path d="${atLimit}"/>`)).components).toHaveLength(1);
    expect(() => validateLogoVectorSvg(svg(`<path d="${atLimit}M20 20"/>`))).toThrowError(expect.objectContaining({code:"limit_exceeded"}));
    const prefix='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'+triangle+'<!--';
    const suffix='--></svg>';
    const source=bytes(prefix+' '.repeat(VECTOR_LIMITS.bytes-prefix.length-suffix.length)+suffix);
    expect(validateLogoVectorSvg(source).components).toHaveLength(1);
    expect(() => validateLogoVectorSvg(new Uint8Array(VECTOR_LIMITS.bytes+1))).toThrowError(expect.objectContaining({code:"limit_exceeded"}));
  });
});


describe("G1: stroke visibility within each subpath", () => {
  it.each([
    ["lines", "M20 20L20 20 M80 80L80 80"],
    ["cubics", "M20 20C20 20 20 20 20 20 M80 80C80 80 80 80 80 80"],
  ])("rejects disconnected zero-length %s despite a nonzero aggregate bounding box", (_kind, d) => {
    expect(() => validateLogoVectorSvg(svg(`<path d="${d}" fill="none" stroke="#000" stroke-width="1" stroke-linecap="butt"/>`))).toThrowError(expect.objectContaining({ code: "empty_artwork" }));
  });
  it("keeps actual disconnected nonzero-length strokes and nonconstant closed curves", () => {
    for (const d of ["M20 20L30 20 M70 80L80 80", "M20 20C30 20 30 30 20 20"]) {
      const document = validateLogoVectorSvg(svg(`<path d="${d}" fill="none" stroke="#000" stroke-width="1" stroke-linecap="butt"/>`));
      expect(flattenLogoPaths(validateLogoVectorSvg(serializeLogoSvg(document)))).toEqual(flattenLogoPaths(document));
    }
  });
});
