// Design-audit pass 3b: contrast table for the proposed colour roles. No dependencies; reuses contrast.mjs.
//
//   node design-audit/tools/ds-contrast.mjs   -> prints the tables and writes evidence/design-system/contrast.md
//
// Every text/background and icon/background pair in 05_design_system.md section 3b is listed here with its
// calculated WCAG 2.x ratio and the minimum that role must meet. Where a value is still a candidate, every
// candidate is listed. To try another value, add it to PRIMITIVES / CANDIDATES below and run again.
// Ratios are floored to two decimals (contrast.mjs `round`), so a failing ratio is never rounded up to a pass.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ratio, round, parse, over } from "./contrast.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "evidence", "design-system");

// ---- values ------------------------------------------------------------------------------------------------------

/** Kept from today's tokens unless marked NEW. */
const P = {
  "neutral-0": "#ffffff", // paper
  "neutral-50": "#f7f7f5", // canvas
  "neutral-100": "#f1f0ee", // surface (sunken fill, hover fill)
  "neutral-200": "#e4e3df", // hairline
  "neutral-300": "#c9c8c2", // strong hairline
  "neutral-400": "#a3a29d", // NEW: disabled text / icon
  "neutral-500": "#85847f", // NEW: control outline
  "neutral-600": "#696965", // muted text (today's --secondary)
  "neutral-800": "#3a3a37", // ink hover (today an untokenised literal, 8 uses)
  "neutral-900": "#191919", // ink
  "green-50": "#eef3ef",
  "green-700": "#3d6448",
  "red-50": "#faeeee",
  "red-200": "#e5c4c4",
  "red-500": "#b54b4b", // today's untokenised error border
  "red-700": "#a42a2a",
  "amber-50": "#fff8e9",
  "amber-200": "#e3ce9c",
  "amber-600": "#9a7326", // NEW: warning outline
  "amber-800": "#6b4617",
};

const surfaces = { paper: P["neutral-0"], canvas: P["neutral-50"], surface: P["neutral-100"] };

const TEXT = 4.5;
const UI = 3;

const groups = [];
const group = (title, note, rows) => groups.push({ title, note, rows });
/** rows: [role, foreground label, fg, background label, bg, minimum (number or null), remark] */
const on = (role, fgName, fg, bgs, min, remark = "") => Object.entries(bgs).map(([bgName, bg]) => [role, fgName, fg, bgName, bg, min, remark]);

// ---- 1. text ------------------------------------------------------------------------------------------------------

group("Text on surfaces", "Minimum 4.5:1 (WCAG 1.4.3).", [
  ...on("color-text", "neutral-900", P["neutral-900"], surfaces, TEXT),
  ...on("color-text-muted", "neutral-600", P["neutral-600"], surfaces, TEXT, "kept; narrowest pass is on surface"),
  ...on("color-text on status fills", "neutral-900", P["neutral-900"], { "positive-soft": P["green-50"], "danger-soft": P["red-50"], "warning-soft": P["amber-50"] }, TEXT),
  ...on("color-text-muted on status fills", "neutral-600", P["neutral-600"], { "positive-soft": P["green-50"], "danger-soft": P["red-50"], "warning-soft": P["amber-50"] }, TEXT),
  ...on("color-text-positive", "green-700", P["green-700"], { ...surfaces, "positive-soft": P["green-50"] }, TEXT),
  ...on("color-text-danger", "red-700", P["red-700"], { ...surfaces, "danger-soft": P["red-50"] }, TEXT),
  ...on("color-text-warning", "amber-800", P["amber-800"], { ...surfaces, "warning-soft": P["amber-50"] }, TEXT),
]);

group("Text on filled controls", "Minimum 4.5:1.", [
  ["color-on-accent on color-accent (primary button, current nav item)", "neutral-0", P["neutral-0"], "neutral-900", P["neutral-900"], TEXT, ""],
  ["color-on-accent on accent hover — candidate A", "neutral-0", P["neutral-0"], "neutral-800 #3a3a37", P["neutral-800"], TEXT, "one hover ink for buttons and text"],
  ["color-on-accent on accent hover — candidate B", "neutral-0", P["neutral-0"], "#333333 (today)", "#333333", TEXT, "today's --text-strong-hover"],
  ["color-on-danger on color-danger (filled destructive button)", "neutral-0", P["neutral-0"], "red-700", P["red-700"], TEXT, "new: no filled danger button exists today"],
  ["color-text on selected fill (chip, choice card)", "neutral-900", P["neutral-900"], "surface", P["neutral-100"], TEXT, ""],
]);

group("Placeholder text (candidates)", "Minimum 4.5:1 on every field background. Today's #82817b fails (pass 3, A-002).", [
  ...on("candidate A: same as color-text-muted", "neutral-600 #696965", "#696965", surfaces, TEXT, "one fewer token; placeholder and hint look alike"),
  ...on("candidate B: a lighter step", "#6f6e69", "#6f6e69", surfaces, TEXT, "distinguishable from hints; fails on surface, so fields must sit on paper or canvas"),
  ...on("today (for comparison)", "#82817b", "#82817b", surfaces, TEXT, "fails"),
]);

group("Disabled text and icons (candidates)", "WCAG exempts disabled controls. Recommended house minimum: 3:1, so a disabled label can still be read.", [
  ...on("candidate A: neutral-400 on the disabled fill", "#a3a29d", P["neutral-400"], { surface: P["neutral-100"], paper: P["neutral-0"] }, null, "below 3:1: reads as clearly off"),
  ...on("candidate B: a darker step", "#8f8e89", "#8f8e89", { surface: P["neutral-100"], paper: P["neutral-0"] }, null, "meets the 3:1 house minimum on paper, just under it on the disabled fill"),
  ...on("today (for comparison)", "#b0afac", "#b0afac", { surface: P["neutral-100"] }, null, "measured in pass 3"),
  ...on("today's coded disabled button text", "neutral-600", P["neutral-600"], { surface: P["neutral-100"] }, null, "`.button:disabled` in globals.css: indistinguishable from muted text"),
]);

// ---- 2. non-text --------------------------------------------------------------------------------------------------

group("Control outlines (candidates)", "Minimum 3:1 against the background next to the control (WCAG 1.4.11). Today's --border is 1.28:1 (pass 3, A-001).", [
  ...on("color-border-control candidate A", "#85847f", "#85847f", surfaces, UI, "passes on all three surfaces"),
  ...on("color-border-control candidate B", "#8a8985", "#8a8985", surfaces, UI, "pass 3's reference value; lighter; only 3.07:1 on surface"),
  ...on("color-border-control candidate C", "neutral-600 #696965", "#696965", surfaces, UI, "reuses the muted text colour; heaviest"),
  ...on("color-border-control hover / focus", "neutral-900", P["neutral-900"], surfaces, UI),
]);

group("Hairlines (decorative: no minimum)", "Card edges and dividers do not identify a control, so no minimum applies. Listed so the difference from control outlines is visible.", [
  ...on("color-border", "neutral-200", P["neutral-200"], { paper: surfaces.paper, canvas: surfaces.canvas }, null, "kept"),
  ...on("color-border-strong (card hover)", "neutral-300", P["neutral-300"], { paper: surfaces.paper, canvas: surfaces.canvas }, null, "kept"),
]);

group("Status outlines", "Minimum 3:1 when the outline is the only sign of the state; a message with an icon and text does not rely on it.", [
  ...on("color-border-danger (invalid field, danger button)", "red-500", P["red-500"], { paper: surfaces.paper, canvas: surfaces.canvas, "danger-soft": P["red-50"] }, UI, "today an untokenised literal"),
  ...on("color-border-danger-soft (message box edge, decorative)", "red-200", P["red-200"], { "danger-soft": P["red-50"], paper: surfaces.paper }, null, "today's --danger-border; fails as a control outline"),
  ...on("color-border-warning candidate", "amber-600 #9a7326", P["amber-600"], { paper: surfaces.paper, "warning-soft": P["amber-50"] }, UI, "new"),
  ...on("color-border-warning-soft (decorative)", "amber-200", P["amber-200"], { "warning-soft": P["amber-50"] }, null, "today's --warning-border"),
  ...on("color-border-positive", "green-700", P["green-700"], { paper: surfaces.paper, "positive-soft": P["green-50"] }, UI),
]);

group("Icons", "Minimum 3:1 for an icon that is a control or carries meaning on its own (WCAG 1.4.11); icons beside a text label take the text colour.", [
  ...on("color-icon (default, same as color-text)", "neutral-900", P["neutral-900"], surfaces, UI),
  ...on("color-icon-muted", "neutral-600", P["neutral-600"], surfaces, UI),
  ["color-icon on color-accent (send arrow, checked box)", "neutral-0", P["neutral-0"], "neutral-900", P["neutral-900"], UI, ""],
  ...on("status icon: positive", "green-700", P["green-700"], { paper: surfaces.paper, "positive-soft": P["green-50"] }, UI),
  ...on("status icon: danger", "red-700", P["red-700"], { paper: surfaces.paper, "danger-soft": P["red-50"] }, UI),
  ...on("status icon: warning", "amber-800", P["amber-800"], { paper: surfaces.paper, "warning-soft": P["amber-50"] }, UI),
]);

// focus ring: 2px ink ring with a 2px paper halo outside it, so one of the two always contrasts
const darkTiles = { "dark artwork #121212": "#121212", "dark artwork #030436": "#030436", "mid artwork #7a7a7a": "#7a7a7a" };
group("Focus ring (two-colour)", "Minimum 3:1 against the adjacent colour (WCAG 2.4.7, 1.4.11). The ring is ink with a paper halo; on any background at least one of the two must pass.", [
  ...on("focus-ring-color (ink) on app surfaces", "neutral-900", P["neutral-900"], surfaces, UI),
  ...on("focus-ring-color (ink) on artwork", "neutral-900", P["neutral-900"], darkTiles, UI, "ink alone fails on dark artwork: today's problem (A-005)"),
  ...on("focus-ring-halo (paper) on artwork", "neutral-0", P["neutral-0"], darkTiles, UI, "the halo carries the ring where ink fails"),
  ["ink ring against its own paper halo", "neutral-900", P["neutral-900"], "neutral-0", P["neutral-0"], UI, "the two parts are always distinguishable"],
]);

group("Selection and choice controls", "Minimum 3:1 for the mark that shows a choice is selected.", [
  ...on("selected ring / border (ink)", "neutral-900", P["neutral-900"], { paper: surfaces.paper, canvas: surfaces.canvas, surface: surfaces.surface }, UI),
  ["checkbox / radio: checked fill against the card", "neutral-900", P["neutral-900"], "paper", surfaces.paper, UI, ""],
  ["checkbox / radio: tick on the checked fill", "neutral-0", P["neutral-0"], "neutral-900", P["neutral-900"], UI, ""],
  ...on("checkbox / radio: unchecked outline (= color-border-control A)", "#85847f", "#85847f", { paper: surfaces.paper, surface: surfaces.surface }, UI),
]);

// controls drawn on artwork: an ink icon on a paper chip at 92% over the image
const chipOver = (bg) => {
  const c = over(parse("rgb(255 255 255 / 92%)"), parse(bg));
  return `rgb(${c.slice(0, 3).map((v) => Math.round(v)).join(" ")})`;
};
group("Controls on artwork (heart, expand, close)", "Minimum 3:1 for the icon against its chip, on any image. Chip: paper at 92% opacity (already used by the gallery toolbar).", [
  ["icon (ink) on chip over dark artwork #121212", "neutral-900", P["neutral-900"], chipOver("#121212"), chipOver("#121212"), UI, "chip composited over the image"],
  ["icon (ink) on chip over white artwork", "neutral-900", P["neutral-900"], chipOver("#ffffff"), chipOver("#ffffff"), UI, ""],
  ["chip edge against dark artwork", chipOver("#121212"), chipOver("#121212"), "#121212", "#121212", UI, "the chip itself is visible on dark images"],
  ["chip edge against white artwork (needs the hairline)", "neutral-300 hairline", P["neutral-300"], "#ffffff", "#ffffff", null, "on white images the chip is found by its icon, which passes"],
]);

// ---- 3. accent options ----------------------------------------------------------------------------------------------

// blue is the one hue family with no status meaning in this palette (green, red and amber are taken)
const accentCandidates = { "ink blue #24406b": "#24406b", "slate #3d4f63": "#3d4f63" };
const accentRows = [];
for (const [name, value] of Object.entries(accentCandidates)) {
  accentRows.push(...on(`Option B accent as text or icon: ${name}`, name, value, surfaces, TEXT));
  accentRows.push([`Option B on-accent text on ${name}`, "neutral-0", P["neutral-0"], name, value, TEXT, ""]);
  accentRows.push([`Option B accent against the positive green (must not be confused with a status)`, name, value, "green-700", P["green-700"], null, "hue, not lightness, has to separate them"]);
  accentRows.push([`Option B accent as a selection ring next to ink text: ${name}`, name, value, "neutral-900 (must differ from ink)", P["neutral-900"], null, "below 3:1 means the accent cannot be told from ink by lightness alone"]);
}
group("Accent (decide in Claude Design)", "Option A keeps ink as the only emphasis colour (rows above). Option B adds one quiet accent for selection, links and focus. Minimums for whichever value is chosen: 4.5:1 as text on paper, canvas and surface; 4.5:1 for text on it; 3:1 as a ring or icon.", accentRows);

// ---- output -----------------------------------------------------------------------------------------------------

const lines = ["# Contrast of the proposed colour roles", "", `Generated by \`design-audit/tools/ds-contrast.mjs\` on ${new Date().toISOString().slice(0, 10)}. Ratios are WCAG 2.x, floored to two decimals.`, ""];
let failures = 0;
for (const g of groups) {
  lines.push(`## ${g.title}`, "", g.note, "", "| Role | Foreground | Background | Ratio | Minimum | Result | Note |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const [role, fgName, fg, bgName, bg, min, remark] of g.rows) {
    const value = ratio(fg, bg);
    const result = min === null ? "no minimum" : value >= min ? "pass" : "**fail**";
    if (min !== null && value < min) failures += 1;
    const show = (name, hex) => (name.includes("#") || name.startsWith("rgb") ? `\`${name}\`` : `${name} \`${hex}\``);
    lines.push(`| ${role} | ${show(fgName, fg)} | ${show(bgName, bg)} | ${round(value)}:1 | ${min === null ? "none" : `${min}:1`} | ${result} | ${remark} |`);
  }
  lines.push("");
}
lines.push(`Rows below their minimum: ${failures} (all are candidates or today's values listed for comparison; see the notes).`, "");
const md = lines.join("\n");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "contrast.md"), md);
console.log(md);
