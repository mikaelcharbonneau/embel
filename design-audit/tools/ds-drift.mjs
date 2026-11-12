// Design-audit pass 3b: measure design-system drift from code. Read-only on src/. No dependencies.
//
//   node design-audit/tools/ds-drift.mjs            -> writes evidence/design-system/drift.json and drift.md
//   node design-audit/tools/ds-drift.mjs color      -> also prints one category's full table to the terminal
//
// What it does: reads every stylesheet under src/, splits it into declarations (property: value), and for each
// foundation (colour, font size, weight, line height, letter spacing, spacing, radius, shadow, z-index,
// breakpoints, durations, easings, control heights, page widths) counts every distinct value, whether it came
// through a token (var(--…)) or was written literally, and keeps file:line examples.
// It also counts colour literals and inline style objects in .tsx/.ts files.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const srcDir = join(root, "src");
const outDir = join(here, "..", "evidence", "design-system");

function walk(dir, test, found = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, test, found);
    else if (test(name)) found.push(path);
  }
  return found;
}

const cssFiles = walk(srcDir, (n) => n.endsWith(".css")).sort();
const codeFiles = walk(srcDir, (n) => /\.(tsx|ts)$/u.test(n) && !/\.(test|spec)\./u.test(n)).sort();

// ---- declarations --------------------------------------------------------------------------------------------

/** Blank out comments but keep newlines, so offsets still map to the right line. */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, " "));

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

const declarations = []; // { file, line, prop, value }
const atRules = []; // { file, line, kind, query }
for (const file of cssFiles) {
  const text = stripComments(readFileSync(file, "utf8"));
  const rel = relative(root, file);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const toLine = (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  for (const m of text.matchAll(/(?<=^|[;{}\s])(--[\w-]+|[a-z-]+)\s*:\s*([^;{}]+?)\s*(?=;|\})/gu)) {
    declarations.push({ file: rel, line: toLine(m.index), prop: m[1], value: m[2].replace(/\s+/gu, " ").trim() });
  }
  for (const m of text.matchAll(/@(media|container)\s*([^{]+)\{/gu)) {
    atRules.push({ file: rel, line: toLine(m.index), kind: m[1], query: m[2].replace(/\s+/gu, " ").trim() });
  }
}
void lineAt;

// ---- tallies -------------------------------------------------------------------------------------------------

class Tally {
  constructor() {
    this.map = new Map();
  }
  add(value, where) {
    const entry = this.map.get(value) ?? { value, count: 0, files: new Set(), examples: [] };
    entry.count += 1;
    entry.files.add(where.split(":")[0]);
    if (entry.examples.length < 4) entry.examples.push(where);
    this.map.set(value, entry);
  }
  rows() {
    return [...this.map.values()]
      .map((e) => ({ value: e.value, count: e.count, files: e.files.size, examples: e.examples }))
      .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
  }
  get distinct() {
    return this.map.size;
  }
  get total() {
    return [...this.map.values()].reduce((sum, e) => sum + e.count, 0);
  }
}

const cat = Object.fromEntries(
  [
    "colorToken",
    "colorLiteral",
    "colorKeyword",
    "fontSizeToken",
    "fontSizeLiteral",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "fontFamily",
    "spacingToken",
    "spacingLiteral",
    "radiusToken",
    "radiusLiteral",
    "shadow",
    "zIndex",
    "duration",
    "easing",
    "transitionProperty",
    "keyframes",
    "controlHeight",
    "maxWidth",
    "tokenDefinedOutsideTokenFile",
    "important",
    "outlineNone",
    "focusVisible",
    "opacity",
    "borderWidth",
  ].map((k) => [k, new Tally()]),
);

const colorProps =
  /^(color|background|background-color|border|border-(top|right|bottom|left)|border-color|border-(top|right|bottom|left)-color|outline|outline-color|box-shadow|fill|stroke|caret-color|accent-color|text-decoration-color|text-decoration|column-rule|background-image)$/u;
const spacingProps =
  /^(padding|padding-(top|right|bottom|left|inline|block)(-start|-end)?|margin|margin-(top|right|bottom|left|inline|block)(-start|-end)?|gap|row-gap|column-gap|inset|top|right|bottom|left)$/u;
const strictSpacing =
  /^(padding|padding-(top|right|bottom|left|inline|block)(-start|-end)?|margin|margin-(top|right|bottom|left|inline|block)(-start|-end)?|gap|row-gap|column-gap)$/u;
const colorLiteral = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|color-mix\([^)]*\)/giu;
const colorKeyword = /\b(white|black|transparent|currentcolor)\b/giu;
const varUse = /var\(\s*(--[\w-]+)/gu;

/** Split a value on spaces (and "/") that are not inside parentheses, so calc(a - b) stays one part. */
const splitTop = (value) => {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth === 0 && (ch === " " || ch === "/")) {
      if (current) parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
};

const normHex = (hex) => {
  let h = hex.toLowerCase();
  if (h.length === 4) h = `#${[...h.slice(1)].map((c) => c + c).join("")}`;
  return h;
};

const tokenFile = "src/styles/tokens.css";
const definedTokens = new Map(); // name -> value (from tokens.css)
for (const d of declarations) if (d.file === tokenFile && d.prop.startsWith("--")) definedTokens.set(d.prop, d.value);

const tokenUse = new Tally();
for (const d of declarations) {
  const where = `${d.file}:${d.line}`;
  if (/!important/u.test(d.value)) cat.important.add(d.prop, where);
  const value = d.value.replace(/\s*!important/u, "");

  for (const m of value.matchAll(varUse)) tokenUse.add(m[1], where);

  if (d.prop.startsWith("--")) {
    if (d.file !== tokenFile) cat.tokenDefinedOutsideTokenFile.add(`${d.prop}: ${value}`, where);
    // literals inside custom properties still count as colour literals when they are colours
    for (const m of value.matchAll(colorLiteral))
      if (d.file !== tokenFile)
        cat.colorLiteral.add(m[0].startsWith("#") ? normHex(m[0]) : m[0].replace(/\s+/gu, " "), where);
    continue;
  }

  if (colorProps.test(d.prop)) {
    for (const m of value.matchAll(colorLiteral))
      cat.colorLiteral.add(m[0].startsWith("#") ? normHex(m[0]) : m[0].replace(/\s+/gu, " "), where);
    for (const m of value.matchAll(colorKeyword)) cat.colorKeyword.add(m[0].toLowerCase(), where);
    for (const m of value.matchAll(varUse)) {
      const def = definedTokens.get(m[1]);
      if (def && (/^#|^rgb|^hsl/u.test(def) || /gradient/u.test(def))) cat.colorToken.add(m[1], where);
    }
  }

  if (d.prop === "font-size" || d.prop === "font") {
    const sizeTokens = [...value.matchAll(varUse)].map((m) => m[1]);
    if (sizeTokens.length) for (const t of sizeTokens) cat.fontSizeToken.add(t, where);
    else if (d.prop === "font-size") cat.fontSizeLiteral.add(value, where);
  }
  if (d.prop === "font-weight") cat.fontWeight.add(value, where);
  if (d.prop === "line-height") cat.lineHeight.add(value, where);
  if (d.prop === "letter-spacing") cat.letterSpacing.add(value, where);
  if (d.prop === "font-family") cat.fontFamily.add(value, where);

  if (strictSpacing.test(d.prop)) {
    for (const part of splitTop(value)) {
      if (/^(var|calc|min|max|clamp)\(/u.test(part)) {
        if (/var\(/u.test(part)) cat.spacingToken.add(part, where);
      } else if (/^-?\d*\.?\d+(px|rem|em)$/u.test(part)) cat.spacingLiteral.add(part.replace(/^-/u, ""), where);
    }
  }
  void spacingProps;

  if (/^border(-(top|bottom)-(left|right))?-radius$/u.test(d.prop)) {
    for (const part of splitTop(value)) {
      if (/var\(/u.test(part)) cat.radiusToken.add(part.match(/var\(\s*(--[\w-]+)/u)[1], where);
      else if (part && part !== "0") cat.radiusLiteral.add(part, where);
    }
  }

  if (d.prop === "box-shadow" && value !== "none") cat.shadow.add(value, where);
  if (d.prop === "z-index") cat.zIndex.add(value, where);
  if (d.prop === "opacity") cat.opacity.add(value, where);
  if (/^border(-(top|right|bottom|left))?(-width)?$/u.test(d.prop)) {
    const w = value.match(/(?<![\w.-])(\d*\.?\d+px)/u);
    if (w) cat.borderWidth.add(w[1], where);
  }

  if (/^(transition|animation)(-duration|-delay)?$/u.test(d.prop)) {
    for (const m of value.matchAll(/(?<![\w.-])(\d*\.?\d+)(ms|s)\b/gu)) {
      const ms = m[2] === "s" ? Math.round(parseFloat(m[1]) * 1000) : parseFloat(m[1]);
      cat.duration.add(`${ms}ms (${d.prop.split("-")[0]})`, where);
    }
  }
  if (/^(transition|animation)(-timing-function)?$/u.test(d.prop)) {
    for (const m of value.matchAll(
      /cubic-bezier\([^)]*\)|steps\([^)]*\)|\b(ease-in-out|ease-in|ease-out|ease|linear)\b/gu,
    ))
      cat.easing.add(m[0], where);
  }
  if (d.prop === "transition" || d.prop === "transition-property") {
    for (const part of value.split(",")) {
      const name = part.trim().split(/\s+/u)[0];
      if (name && !/^\d/u.test(name)) cat.transitionProperty.add(name, where);
    }
  }
  if (d.prop === "outline" && /^(none|0)$/u.test(value)) cat.outlineNone.add(value, where);
  if (/^(min-height|height)$/u.test(d.prop) && /^\d+px$/u.test(value))
    cat.controlHeight.add(`${d.prop}: ${value}`, where);
  if (d.prop === "max-width" && /px|ch|rem/u.test(value)) cat.maxWidth.add(value, where);
}

// keyframes and focus rules need the raw text
const focusRules = new Tally();
for (const file of cssFiles) {
  const text = stripComments(readFileSync(file, "utf8"));
  const rel = relative(root, file);
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const k = line.match(/@keyframes\s+([\w-]+)/u);
    if (k) cat.keyframes.add(k[1], `${rel}:${i + 1}`);
    if (/:focus-visible|:focus-within|:focus\b/u.test(line))
      cat.focusVisible.add(
        line.includes(":focus-visible")
          ? ":focus-visible"
          : line.includes(":focus-within")
            ? ":focus-within"
            : ":focus",
        `${rel}:${i + 1}`,
      );
    const off = line.match(/outline-offset\s*:\s*([^;]+)/u);
    if (off) focusRules.add(off[1].trim(), `${rel}:${i + 1}`);
  });
}

// breakpoints
const breakpoints = new Tally();
for (const rule of atRules) {
  for (const m of rule.query.matchAll(
    /\((min|max)-(width|height)\s*:\s*([\d.]+px)\)|\((width|height)\s*(<=|>=|<|>)\s*([\d.]+px)\)/gu,
  )) {
    const label = m[1] ? `${rule.kind} ${m[1]}-${m[2]}: ${m[3]}` : `${rule.kind} ${m[4]} ${m[5]} ${m[6]}`;
    breakpoints.add(label, `${rule.file}:${rule.line}`);
  }
  if (/prefers-reduced-motion|hover:|pointer:|prefers-color-scheme|forced-colors|prefers-contrast/u.test(rule.query))
    breakpoints.add(`${rule.kind} ${rule.query}`, `${rule.file}:${rule.line}`);
}

// code files: colour literals, inline styles, class usage
const codeColor = new Tally();
const inlineStyle = new Tally();
const classUse = new Tally();
for (const file of codeFiles) {
  const rel = relative(root, file);
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/["'`]#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/gu))
      codeColor.add(normHex(`#${m[1]}`), `${rel}:${i + 1}`);
    if (/style=\{\{/u.test(line) || /style=\{[a-zA-Z]/u.test(line)) inlineStyle.add(rel, `${rel}:${i + 1}`);
    for (const m of line.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\}|\{"([^"]+)"\})/gu)) {
      const names = (m[1] ?? m[2] ?? m[3]).split(/\s+/u);
      for (const name of names) if (/^[a-z][\w-]*$/u.test(name)) classUse.add(name, `${rel}:${i + 1}`);
    }
  });
}

// per-file literal load (which files bypass tokens most)
const perFile = new Map();
const bump = (file, key) => {
  const row = perFile.get(file) ?? {
    file,
    colorLiteral: 0,
    fontSizeLiteral: 0,
    radiusLiteral: 0,
    shadow: 0,
    spacingLiteral: 0,
  };
  row[key] += 1;
  perFile.set(file, row);
};
for (const key of ["colorLiteral", "fontSizeLiteral", "radiusLiteral", "shadow", "spacingLiteral"]) {
  for (const entry of cat[key].map.values()) {
    // examples are capped, so recount from declarations below instead
    void entry;
  }
}
for (const d of declarations) {
  if (d.prop.startsWith("--")) continue;
  const value = d.value;
  if (colorProps.test(d.prop)) for (const _ of value.matchAll(colorLiteral)) bump(d.file, "colorLiteral");
  if (d.prop === "font-size" && !/var\(/u.test(value)) bump(d.file, "fontSizeLiteral");
  if (/^border(-(top|bottom)-(left|right))?-radius$/u.test(d.prop) && !/var\(/u.test(value) && value !== "0")
    bump(d.file, "radiusLiteral");
  if (d.prop === "box-shadow" && value !== "none") bump(d.file, "shadow");
}

// ---- output --------------------------------------------------------------------------------------------------

const result = {
  generatedAt: new Date().toISOString(),
  files: { css: cssFiles.length, code: codeFiles.length, declarations: declarations.length },
  tokensDefined: Object.fromEntries(definedTokens),
  tokenUse: tokenUse.rows(),
  unusedTokens: [...definedTokens.keys()].filter((name) => !tokenUse.map.has(name)),
  categories: Object.fromEntries(
    Object.entries(cat).map(([k, t]) => [k, { distinct: t.distinct, total: t.total, rows: t.rows() }]),
  ),
  outlineOffset: focusRules.rows(),
  breakpoints: breakpoints.rows(),
  code: {
    colorLiterals: { distinct: codeColor.distinct, total: codeColor.total, rows: codeColor.rows() },
    inlineStyleFiles: inlineStyle.rows(),
    classUse: classUse.rows().slice(0, 150),
  },
  perFile: [...perFile.values()].sort(
    (a, b) =>
      b.colorLiteral +
      b.fontSizeLiteral +
      b.radiusLiteral +
      b.shadow -
      (a.colorLiteral + a.fontSizeLiteral + a.radiusLiteral + a.shadow),
  ),
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "drift.json"), `${JSON.stringify(result, null, 2)}\n`);

const table = (title, rows, limit = 60) =>
  [
    `### ${title}`,
    "",
    "| Value | Uses | Files | Examples |",
    "| --- | --- | --- | --- |",
    ...rows.slice(0, limit).map(
      (r) =>
        `| \`${String(r.value).replace(/\|/gu, "\\|")}\` | ${r.count} | ${r.files} | ${r.examples
          .slice(0, 2)
          .map((e) => `\`${e}\``)
          .join(", ")} |`,
    ),
    rows.length > limit ? `\n(${rows.length - limit} more in drift.json)` : "",
    "",
  ].join("\n");

const summaryRow = (label, key) => `| ${label} | ${cat[key].distinct} | ${cat[key].total} |`;
const md = [
  "# Design-system drift, measured from code",
  "",
  `Generated by \`design-audit/tools/ds-drift.mjs\` on ${result.generatedAt.slice(0, 10)}. ${cssFiles.length} stylesheets, ${declarations.length} declarations, ${codeFiles.length} .ts/.tsx files.`,
  "",
  "| Foundation | Distinct values | Uses |",
  "| --- | --- | --- |",
  summaryRow("Colour through a token", "colorToken"),
  summaryRow("Colour written literally (hex, rgb, color-mix)", "colorLiteral"),
  summaryRow("Colour keywords (white, black, transparent, currentColor)", "colorKeyword"),
  summaryRow("Font size through a token", "fontSizeToken"),
  summaryRow("Font size written literally", "fontSizeLiteral"),
  summaryRow("Font weight", "fontWeight"),
  summaryRow("Line height", "lineHeight"),
  summaryRow("Letter spacing", "letterSpacing"),
  summaryRow("Font family", "fontFamily"),
  summaryRow("Spacing through a token (padding, margin, gap)", "spacingToken"),
  summaryRow("Spacing written literally", "spacingLiteral"),
  summaryRow("Radius through a token", "radiusToken"),
  summaryRow("Radius written literally", "radiusLiteral"),
  summaryRow("Box shadow", "shadow"),
  summaryRow("z-index", "zIndex"),
  summaryRow("Durations", "duration"),
  summaryRow("Easings", "easing"),
  summaryRow("Keyframes", "keyframes"),
  summaryRow("Fixed heights (height / min-height in px)", "controlHeight"),
  summaryRow("max-width values", "maxWidth"),
  summaryRow("Custom properties defined outside tokens.css", "tokenDefinedOutsideTokenFile"),
  summaryRow("!important", "important"),
  `| Breakpoints and feature queries | ${breakpoints.distinct} | ${breakpoints.total} |`,
  `| Colour literals in .ts/.tsx | ${codeColor.distinct} | ${codeColor.total} |`,
  `| Files with inline style objects | ${inlineStyle.distinct} | ${inlineStyle.total} |`,
  "",
  `Tokens defined in tokens.css: ${definedTokens.size}. Never referenced anywhere in src/**/*.css: ${result.unusedTokens.map((t) => `\`${t}\``).join(", ") || "none"}.`,
  "",
  table("Token use (var(--…) references in CSS)", tokenUse.rows(), 80),
  table("Colour literals in CSS", cat.colorLiteral.rows(), 90),
  table("Colour keywords", cat.colorKeyword.rows()),
  table("Font sizes: literal", cat.fontSizeLiteral.rows()),
  table("Font sizes: token", cat.fontSizeToken.rows()),
  table("Font weights", cat.fontWeight.rows()),
  table("Line heights", cat.lineHeight.rows()),
  table("Letter spacing", cat.letterSpacing.rows()),
  table("Font families", cat.fontFamily.rows()),
  table("Spacing: literal", cat.spacingLiteral.rows()),
  table("Spacing: token", cat.spacingToken.rows()),
  table("Radius: literal", cat.radiusLiteral.rows()),
  table("Radius: token", cat.radiusToken.rows()),
  table("Box shadows", cat.shadow.rows()),
  table("z-index", cat.zIndex.rows()),
  table("Durations", cat.duration.rows()),
  table("Easings", cat.easing.rows()),
  table("Transitioned properties", cat.transitionProperty.rows()),
  table("Keyframes", cat.keyframes.rows()),
  table("Breakpoints and feature queries", breakpoints.rows()),
  table("Fixed heights", cat.controlHeight.rows(), 40),
  table("max-width", cat.maxWidth.rows(), 50),
  table("Outline offsets", focusRules.rows()),
  table("outline: none", cat.outlineNone.rows()),
  table("Opacity", cat.opacity.rows()),
  table("Border widths", cat.borderWidth.rows()),
  table("Custom properties defined outside tokens.css", cat.tokenDefinedOutsideTokenFile.rows(), 80),
  table("Colour literals in .ts/.tsx", codeColor.rows(), 60),
  table("Files with inline style objects", inlineStyle.rows(), 40),
  "### Literal load per stylesheet (top 20)",
  "",
  "| File | Colour literals | Font-size literals | Radius literals | Shadows |",
  "| --- | --- | --- | --- | --- |",
  ...result.perFile
    .slice(0, 20)
    .map((r) => `| \`${r.file}\` | ${r.colorLiteral} | ${r.fontSizeLiteral} | ${r.radiusLiteral} | ${r.shadow} |`),
  "",
].join("\n");
writeFileSync(join(outDir, "drift.md"), md);

console.log(md.split("\n").slice(0, 36).join("\n"));
const want = process.argv[2];
if (want && result.categories[want])
  console.table(
    result.categories[want].rows
      .slice(0, 80)
      .map((r) => ({ value: r.value, count: r.count, files: r.files, example: r.examples[0] })),
  );
console.log(`\nWrote ${relative(root, join(outDir, "drift.json"))} and drift.md`);
