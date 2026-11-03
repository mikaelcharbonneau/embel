import { describe, expect, it } from "vitest";
import { describeVisualDirections } from "../../src/components/visual-directions/direction-presentation";
import type { IdentitySystemVersion } from "../../src/domain/project-identity";
import { fixtureSystem } from "./project-identity-fixtures";

function system(index: number, composition: string): IdentitySystemVersion {
  const board = fixtureSystem(undefined, index);
  return { ...board, components: { ...board.components, composition: { direction: composition, usageNotes: "" },
    colors: { swatches: [
      { key: "paper", name: "Warm paper", hex: "#FFFFFF" }, { key: "warm", name: "Tangerine", hex: "#FA8536" },
      { key: "pine", name: "Pine", hex: "#204123" }, { key: "ink", name: "Ink", hex: "#122312" },
    ], usageNotes: "" },
    typography: { styles: [
      { key: "body", role: "Body", family: "Manrope", weight: 400, style: "normal" },
      { key: "display", role: "Display", family: "Fraunces", weight: 600, style: "normal" },
    ], usageNotes: "" },
  }, applicationDesign: { version: 1, layout: "editorial", graphic: "fine_lines", headingStyleKey: "display", bodyStyleKey: "body",
    paletteRoles: { primary: "pine", accent: "warm", background: "paper", text: "ink" } } };
}

describe("visual direction descriptions", () => {
  it("uses the palette and heading keys from the saved design instead of array order", () => {
    const guide = system(2, "Use an editorial field-guide layout for everyday outings.");
    const [card] = describeVisualDirections([guide]);
    expect(card).toMatchObject({ id: guide.id, title: "Everyday Field Guide", sampleStyle: guide.components.typography.styles[1],
      swatches: [{ name: "Pine", hex: "#204123" }, { name: "Tangerine", hex: "#FA8536" },
        { name: "Warm paper", hex: "#FFFFFF" }, { name: "Ink", hex: "#122312" }] });
    expect(card!.summary).toBe("Fine rules organize an editorial grid in Pine.");
  });

  it("uses positive saved descriptions, excluding contrasts to other boards", () => {
    const workshop = system(1, "A friendly workshop with rounded panels. This replaces the earlier field-guide look.");
    const handbook = system(0, "Create a pocket handbook rather than a field guide.");
    expect(describeVisualDirections([workshop, handbook]).map(board => board.title)).toEqual(["Friendly Workshop", "Pocket Handbook"]);
    expect(describeVisualDirections([handbook, workshop]).map(board => board.title)).toEqual(["Pocket Handbook", "Friendly Workshop"]);
  });

  it("names an unrelated direction from its saved palette and graphic treatment", () => {
    const abstract = system(0, "Lay out a gallery invitation. Avoid a field guide or handbook.");
    expect(describeVisualDirections([abstract])[0]?.title).toBe("Pine Linework");
  });

  it("prefers a direction's explicitly attributed title, ignoring unrelated quoted headlines", () => {
    const named = system(0, 'An identity direction named “Paper Lantern” uses open space. Set the headline to “Welcome home”.');
    const headline = system(1, 'Set the headline to “Welcome home”. Use fine rules.');
    expect(describeVisualDirections([named, headline]).map(board => board.title)).toEqual(["Paper Lantern", "Pine Linework"]);
  });

  it.each([
    ['“Rider’s Atlas”.', "Rider’s Atlas"],
    ['"Common Ground."', "Common Ground"],
    ["‘Town & Tide’.", "Town & Tide"],
    ["'Maker's Bench'.", "Maker's Bench"],
    ['«Studio No. 2».', "Studio No. 2"],
  ])("uses the title and first saved comparison sentence after %s", (quoted, title) => {
    const summary = "Broad margins let each photograph breathe.";
    const board = system(0, `The direction is called ${quoted} ${summary} Set secondary labels on the baseline.`);
    expect(describeVisualDirections([board])[0]).toMatchObject({ title, summary });
  });

  it("keeps the palette-based summary when bespoke copy is empty, unfinished or too long", () => {
    for (const tail of ["", "A sentence without its ending", "Word ".repeat(50) + "end."]) {
      const [card] = describeVisualDirections([system(0, `The direction is called “Arc Light”. ${tail}`)]);
      expect(card).toMatchObject({ title: "Arc Light", summary: "Fine rules organize an editorial grid in Pine." });
    }
  });

  it("uses the legacy body style for the sample and keeps its existing role", () => {
    const legacy = fixtureSystem();
    const [card] = describeVisualDirections([legacy]);
    expect(card).toMatchObject({ title: "Forest Study", summary: legacy.components.composition.direction, sampleStyle: legacy.components.typography.styles[0],
      swatches: [{ name: "Forest", hex: "#123456" }] });
    const long = { ...legacy, components: { ...legacy.components, composition: { ...legacy.components.composition, direction: "Spacious artwork ".repeat(40) } } };
    expect(describeVisualDirections([long])[0]!.summary.length).toBeLessThanOrEqual(180);
  });

  it("uses saved headline families to distinguish boards with the same palette", () => {
    const one = system(0, "Create a field guide.");
    const two = system(1, "Create a field guide.");
    two.components = { ...two.components, typography: { ...two.components.typography,
      styles: two.components.typography.styles.map(style => style.key === "display" ? { ...style, family: "Lora" } : style) } };
    expect(describeVisualDirections([two, one]).map(card => card.title)).toEqual(["Field Guide · Lora", "Field Guide · Fraunces"]);
  });

  it("distinguishes related boards by palette before falling back to a number for true ties", () => {
    const one = system(0, "An editorial field guide.");
    const two = system(1, "An editorial field guide.");
    const three = system(2, "An editorial field guide.");
    three.components = { ...three.components, colors: { ...three.components.colors,
      swatches: three.components.colors.swatches.map(swatch => swatch.key === "pine" ? { ...swatch, name: "Olive" } : swatch) } };
    expect(describeVisualDirections([one, three, two]).map(card => card.title)).toEqual(["Field Guide · Pine · 1", "Field Guide · Olive", "Field Guide · Pine · 3"]);
  });
});
