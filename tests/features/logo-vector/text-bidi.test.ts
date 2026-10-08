import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { logoTextBidiClass } from "../../../worker/logo-vector/text-engine";
import data from "../../../worker/logo-vector/text-bidi-data.json";
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
describe("pinned Unicode 17 bidi classification", () => {
  it("binds the official data and included license by exact SHA-256", () => {
    expect(data.unicodeVersion).toBe("17.0.0");
    expect(hash(readFileSync("tests/features/logo-vector/fixtures/unicode/DerivedBidiClass-17.0.0.txt"))).toBe(data.sourceSha256);
    expect(hash(readFileSync("tests/features/logo-vector/fixtures/unicode/Unicode-LICENSE.txt"))).toBe(data.licenseSha256);
    expect(hash(data.licenseNotice)).toBe(data.licenseSha256);
  });
  it.each([[0x0608, "AL"], [0x060b, "AL"], [0x060d, "AL"], [0x061b, "AL"], [0x061f, "AL"], [0x05be, "R"], [0x1f1e6, "L"], [0x0482, "L"], [0x060c, "CS"], [0x20, "WS"], [0x10d40, "AN"], [0x10ec2, "AL"]] as const)("classifies U+%s from reliable data regardless of category", (point, expected) => {
    expect(logoTextBidiClass(point)).toBe(expected);
  });
  it("covers every Unicode code point and honors reserved RTL missing defaults", () => {
    let previous = -1;
    for (const [end, index] of data.ranges) {
      expect(end).toBeGreaterThan(previous); expect(index).toBeGreaterThanOrEqual(0); expect(index).toBeLessThan(data.classes.length);
      expect(logoTextBidiClass(previous + 1)).toBe(data.classes[index!]);
      expect(logoTextBidiClass(end!)).toBe(data.classes[index!]); previous = end!;
    }
    expect(previous).toBe(0x10ffff);
    expect(logoTextBidiClass(0x0590)).toBe("R"); // @missing reserved Hebrew codepoint.
    expect(logoTextBidiClass(0x10ec0)).toBe("AL"); // Unicode 17 @missing Arabic Extended-C.
    expect(logoTextBidiClass(0x20c1)).toBe("ET"); // Reserved Currency Symbols.
  });
  it("matches every explicit class record in the pinned official source", () => {
    const source = readFileSync("tests/features/logo-vector/fixtures/unicode/DerivedBidiClass-17.0.0.txt", "utf8");
    let checked = 0;
    for (const line of source.split("\n")) {
      const record = line.match(/^([0-9A-F]+)(?:\.\.([0-9A-F]+))?\s*; ([A-Z]+)\s*#/);
      if (!record) continue;
      for (let point = parseInt(record[1]!, 16); point <= parseInt(record[2] ?? record[1]!, 16); point++) {
        if (logoTextBidiClass(point) !== record[3]) throw new Error(`Unicode class mismatch at U+${point.toString(16)}`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100_000);
  });

  it.each([-1, 0x110000, NaN, 1.5])("rejects invalid code points: %s", point => {
    expect(() => logoTextBidiClass(point)).toThrowError(expect.objectContaining({ code: "unsupported_text" }));
  });

});
