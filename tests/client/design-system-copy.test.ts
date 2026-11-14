import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** Removes the font stacks, the one part of tokens.css the app adapts (next/font supplies the files). */
const withoutFonts = (css: string) =>
  css
    .split("\n")
    .filter((line) => !line.startsWith("@font-face") && !/^\s*--font-(sans|display):/u.test(line) && !line.startsWith("/*"))
    .filter((line) => !/^\s+(Only the font stacks|which sets --font)/u.test(line))
    .join("\n");

describe("the app's copy of the Embel Design System", () => {
  it("uses the published component layer unchanged", () => {
    expect(read("src/styles/embel/components.css")).toBe(read("design-assets/design-system/components/bundle.css"));
  });

  it("uses the published tokens, with only the font stacks pointed at next/font", () => {
    expect(withoutFonts(read("src/styles/embel/tokens.css"))).toBe(
      withoutFonts(read("design-assets/design-system/tokens.css")),
    );
    const tokens = read("src/styles/embel/tokens.css");
    expect(tokens).toContain("--font-sans: var(--font-geist-sans),");
    expect(tokens).toContain("--font-display: var(--font-instrument-sans),");
  });
});
