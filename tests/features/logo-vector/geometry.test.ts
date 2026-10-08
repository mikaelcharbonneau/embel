import { describe, expect, it } from "vitest";
import { LogoVectorError } from "../../../src/features/logo-vector/model/errors";
import { assertVectorByteLimit, VECTOR_LIMITS } from "../../../src/features/logo-vector/model/limits";

describe("bounded vector input", () => {
  it("accepts the byte ceiling and rejects the next byte with a stable bounded error", () => {
    expect(() => assertVectorByteLimit(new Uint8Array(VECTOR_LIMITS.bytes))).not.toThrow();
    expect(() => assertVectorByteLimit(new Uint8Array(VECTOR_LIMITS.bytes + 1))).toThrowError(expect.objectContaining({ code: "limit_exceeded" }));
    const error = new LogoVectorError("invalid_geometry", "x".repeat(1000));
    expect(error.message.length).toBeLessThanOrEqual(300);
    expect(error.code).toBe("invalid_geometry");
  });
});


import { flattenLogoPaths, validateLogoVectorDocument } from "../../../src/features/logo-vector/model/geometry";
import { separatedLogoDocument } from "./fixtures";

describe("canonical visible geometry", () => {
  it("flattens actual positions, paint alpha, fill rule and uniformly scaled strokes without mutating the source", () => {
    const document = separatedLogoDocument();
    document.components[0]!.transform = { x: 20, y: 0, scale: 1.5, rotation: 0 };
    document.components[0]!.paths[0]!.stroke = { color: "#000000", width: 2, opacity: .4, linecap: "round", linejoin: "round", miterLimit: 4 };
    document.components[0]!.paths[0]!.fill!.opacity = .5;
    const before = JSON.stringify(document);
    const flat = flattenLogoPaths(validateLogoVectorDocument(document));
    expect(flat[0]!.d).toBe("M50 60L80 30L110 60L80 90Z");
    expect(flat[0]!.stroke!.width).toBe(3);
    expect(flat[0]!.stroke!.opacity).toBe(.4);
    expect(flat[0]!.fill!.opacity).toBe(.5);
    expect(flat[1]!.fillRule).toBe("evenodd");
    expect(JSON.stringify(document)).toBe(before);
  });
  it("uses curve extrema and painted stroke bounds to reject clipping", () => {
    const document = separatedLogoDocument();
    document.components[0]!.paths[0]!.d = "M 20 10 C 30 -100 50 -100 60 10 Z";
    expect(() => validateLogoVectorDocument(document)).toThrowError(expect.objectContaining({ code: "invalid_geometry" }));
    const stroke = separatedLogoDocument();
    stroke.components[0]!.paths[0]!.d = "M 0 10 L 0 60";
    stroke.components[0]!.paths[0]!.stroke = { color: "#000000", width: 2, opacity: 1, linecap: "round", linejoin: "round", miterLimit: 4 };
    expect(() => validateLogoVectorDocument(stroke)).toThrowError(expect.objectContaining({ code: "invalid_geometry" }));
  });
  it("rejects duplicate component IDs and transformed overflow using shared schemas", () => {
    const document = separatedLogoDocument();
    document.components[1]!.id = document.components[0]!.id;
    expect(() => validateLogoVectorDocument(document)).toThrowError(expect.objectContaining({ code: "invalid_geometry" }));
    const overflow = separatedLogoDocument();
    overflow.components[0]!.transform.x = 1_000_000;
    expect(() => validateLogoVectorDocument(overflow)).toThrowError(expect.objectContaining({ code: "invalid_geometry" }));
  });
});
