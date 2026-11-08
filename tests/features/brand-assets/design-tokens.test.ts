import { describe, expect, it } from "vitest";
import { designTokens, designTokensCss, designTokensJson, readableBrandColor, SPACING, TYPE_SCALE } from "../../../src/features/brand-assets/model/design-tokens";
import { brandAssetFixture } from "./fixtures";

describe("design system tokens", () => {
  it("come only from the chosen direction's colors and fonts plus the fixed scale", () => {
    const { snapshot } = brandAssetFixture();
    const tokens = designTokens(snapshot);
    expect(tokens.brand).toBe(snapshot.name);
    expect(tokens.colors.map(color => color.hex)).toEqual(snapshot.colors.map(color => color.hex));
    expect(tokens.colors.filter(color => color.role).map(color => color.hex).sort()).toEqual([...new Set(Object.values(snapshot.palette))].sort());
    expect(tokens.fonts).toEqual({ heading: { family: snapshot.heading.family, weight: snapshot.heading.weight }, body: { family: snapshot.body.family, weight: snapshot.body.weight } });
    const css = designTokensCss(tokens);
    for (const color of snapshot.colors) expect(css).toContain(color.hex);
    expect(css).toContain(`--font-heading: "${snapshot.heading.family}"`);
    for (const step of TYPE_SCALE) expect(css).toContain(`--text-${step.key}: ${step.size}px;`);
    for (const value of SPACING) expect(css).toContain(`--space-${value}: ${value}px;`);
    const json = JSON.parse(designTokensJson(tokens));
    expect(json.brand).toBe(snapshot.name); expect(json.role).toEqual(snapshot.palette); expect(json.spacing).toEqual([...SPACING]);
  });
  it("describe a light accent as a fill rather than text and spell color the American way", () => {
    const { snapshot } = brandAssetFixture(), tokens = designTokens(snapshot);
    expect(tokens.colors.find(color => color.role === "accent")?.use).toBe("Highlights and fills, not text");
    const supporting = designTokens({ ...snapshot, colors: [...snapshot.colors, { key: "mist", name: "Mist", hex: "#DDE3E6" }] });
    expect(supporting.colors.at(-1)?.use).toBe("Supporting color");
    expect(readableBrandColor(snapshot, snapshot.palette.accent)).toBe(snapshot.palette.text);
  });
});
