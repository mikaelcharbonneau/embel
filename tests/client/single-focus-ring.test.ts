import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// One focus ring per focus (owner report, November 24: "double borders" on selected components).
// A box that draws the ring for the control inside it (a text field, the reply box, a choice card,
// a name card) must not also draw it when a button inside is focused, and no page-level rule may
// put a second ring on the control inside. Source contracts; the rendered check is the tab-through
// audit described in docs/focus-rings.md.
const system = readFileSync("src/styles/embel/components.css", "utf8");

it("a box draws the ring only for its own field, never for a button inside it", () => {
  expect(system).toContain(".e-input:has(:is(input, textarea, select):focus-visible)");
  expect(system).toContain(".e-composer:has(textarea:focus-visible)");
  expect(system).toContain(".e-choice:has(:is(input, .e-choice__hit):focus-visible)");
  expect(system).toContain(".e-name-card:has(input:focus-visible)");
  for (const box of ["e-input", "e-composer", "e-choice", "e-name-card", "e-composer--floating"])
    expect(system).not.toContain(`.${box}:has(:focus-visible)`);
});

it("the control inside such a box draws no ring of its own", () => {
  expect(system).toMatch(
    /\.e-input > input, \.e-input > select, \.e-input > textarea \{[^}]*outline: none; box-shadow: none/u,
  );
  expect(system).toMatch(/\.e-composer textarea \{[^}]*outline: none; box-shadow: none/u);
  expect(system).toMatch(
    /\.e-choice__hit:focus-visible, \.e-choice input:focus-visible \{ outline: none; box-shadow: none; \}/u,
  );
});

it("no page stylesheet adds a blanket ring on top of the design system's", () => {
  for (const file of ["project-workspace.css", "conversation.css", "globals.css", "guided-conversation.css"]) {
    const css = readFileSync(`src/styles/${file}`, "utf8");
    expect(css, file).not.toMatch(/:is\(button, a, summary, input, textarea, select\):focus-visible/u);
  }
});

it("a bordered box shows focus as one line on its border, with no gap and no halo", () => {
  // The owner's second report: the ring floating outside a box's own border read as two borders.
  const flush = system.match(/\/\* -+ Focus on a bordered box: one line -+ \*\/[\s\S]*$/u)?.[0] ?? "";
  for (const box of [
    ".e-input:has(:is(input, textarea, select):focus-visible)",
    ".e-composer:has(textarea:focus-visible)",
    ".e-choice:has(:is(input, .e-choice__hit):focus-visible)",
    ".e-name-card:has(input:focus-visible)",
    ".e-card--interactive:has(.e-card__link:focus-visible)",
    ".e-chip:focus-visible",
    ".e-button--secondary:focus-visible",
    ".e-icon-button--outlined:focus-visible",
  ])
    expect(flush, box).toContain(box);
  expect(flush).toContain("{ outline-offset: calc(var(--focus-ring-width) / -2); box-shadow: none; }");
  const home = readFileSync("src/styles/home-concept.css", "utf8");
  expect(home).toMatch(
    /\.home-composer\.conversation-composer:has\(textarea:focus-visible\) \{[^}]*outline-offset: calc\(var\(--focus-ring-width\) \/ -2\);[^}]*box-shadow: var\(--shadow-raised\);/u,
  );
});
