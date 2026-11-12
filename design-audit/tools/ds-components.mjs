// Design-audit pass 3b: component-family inventory and unused-selector check. Read-only on src/. No dependencies.
//
//   node design-audit/tools/ds-components.mjs   -> writes evidence/design-system/components.json and components.md
//
// 1. Lists every class selector in every stylesheet and whether any .ts/.tsx file mentions that class name
//    (as a whole word in a string, or as styles.name / styles["name"] for CSS modules). "Unreferenced" is a
//    strong hint of dead CSS, not proof: a class built from a template string would be missed.
// 2. Groups class names into component families by keyword (button, field, dialog, menu, card, badge, tabs,
//    empty, skeleton, spinner, notice, …) so duplicated implementations of one component are visible.
// 3. Counts native building blocks in the components: <dialog>, <details>, <select>, <table>, role=…, etc.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, dirname, basename } from "node:path";
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
const codeFiles = walk(srcDir, (n) => /\.(tsx|ts)$/u.test(n)).sort();
const code = codeFiles.map((file) => ({ file: relative(root, file), text: readFileSync(file, "utf8") }));
const allCode = code.map((c) => c.text).join("\n");

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, " "));
const camel = (name) => name.replace(/-([a-z0-9])/gu, (_, c) => c.toUpperCase());

// ---- 1. selectors and whether they are referenced ---------------------------------------------------------------

const classes = []; // { name, file, line, module, referenced, rules }
for (const file of cssFiles) {
  const rel = relative(root, file);
  const isModule = file.endsWith(".module.css");
  const text = stripComments(readFileSync(file, "utf8"));
  const seen = new Map();
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    // only look at the selector part of a line (before "{"), so values such as "0.5px" or ".48" are ignored
    const selector = line.includes("{") ? line.slice(0, line.indexOf("{")) : /[;:]\s*[^{]*$/u.test(line) && !/,\s*$/u.test(line) ? "" : line;
    for (const m of selector.matchAll(/\.(-?[a-zA-Z_][\w-]*)/gu)) {
      const entry = seen.get(m[1]) ?? { name: m[1], file: rel, line: i + 1, module: isModule, rules: 0 };
      entry.rules += 1;
      seen.set(m[1], entry);
    }
  });
  for (const entry of seen.values()) {
    const word = new RegExp(`(?<![\\w-])${entry.name}(?![\\w-])`, "u");
    entry.referenced = isModule
      ? new RegExp(`\\.${camel(entry.name)}\\b|\\[["'\`]${entry.name}["'\`]\\]`, "u").test(allCode) || word.test(allCode)
      : word.test(allCode);
    classes.push(entry);
  }
}

const perFile = new Map();
for (const c of classes) {
  const row = perFile.get(c.file) ?? { file: c.file, classes: 0, unreferenced: 0, names: [] };
  row.classes += 1;
  if (!c.referenced) {
    row.unreferenced += 1;
    row.names.push(c.name);
  }
  perFile.set(c.file, row);
}

// ---- 2. component families ---------------------------------------------------------------------------------------

const families = [
  ["button", /(^|-)(button|btn|cta|submit|send)(-|$)|action$|-actions?$/u],
  ["text link", /(^|-)(link|text-link)(-|$)/u],
  ["icon button", /icon-button|(^|-)close(-|$)|(^|-)dismiss(-|$)|(^|-)expand(-|$)/u],
  ["field / input", /(^|-)(field|input|textarea|composer|search|placeholder)(-|$)/u],
  ["select / dropdown", /(^|-)(select|dropdown|sort|picker)(-|$)/u],
  ["checkbox / radio / toggle / choice", /(^|-)(checkbox|radio|toggle|check|choice|option|switch)(-|$)/u],
  ["range / slider", /(^|-)(range|slider)(-|$)/u],
  ["dialog / modal / sheet", /(^|-)(dialog|modal|sheet|overlay|backdrop|lightbox)(-|$)/u],
  ["menu / popover", /(^|-)(menu|popover|panel-menu|switcher)(-|$)/u],
  ["card", /(^|-)(card|tile)(-|$)/u],
  ["panel / section surface", /(^|-)(panel|surface|box)(-|$)/u],
  ["badge / chip / pill / tag", /(^|-)(badge|chip|pill|tag|label|count|stage)(-|$)/u],
  ["tabs / segmented", /(^|-)(tabs?|tablist|segment(ed)?|step-navigation|filter)(-|$)/u],
  ["navigation", /(^|-)(nav|navigation|capsule|topbar|breadcrumb|journey-step|steps?)(-|$)/u],
  ["avatar", /(^|-)(avatar|monogram|initials)(-|$)/u],
  ["empty state", /(^|-)(empty|blank|no-results?)(-|$)/u],
  ["skeleton / placeholder", /(^|-)(skeleton|shimmer|loading|placeholder-card|pending)(-|$)/u],
  ["spinner / progress", /(^|-)(spinner|spin|progress|bar|pulse|thinking|activity)(-|$)/u],
  ["notice / alert / message", /(^|-)(notice|alert|error|success|warning|status|message|banner|hint|note|conflict)(-|$)/u],
  ["table / list rows", /(^|-)(table|row|list|grid)(-|$)/u],
  ["tooltip", /(^|-)(tooltip|tip)(-|$)/u],
];

const familyRows = families.map(([family, pattern]) => {
  const members = classes.filter((c) => pattern.test(c.name));
  const files = [...new Set(members.map((m) => m.file))];
  return {
    family,
    classes: members.length,
    referenced: members.filter((m) => m.referenced).length,
    files: files.length,
    fileList: files,
    names: members.map((m) => `${m.name}${m.referenced ? "" : " (unreferenced)"} — ${m.file}:${m.line}`),
  };
});

// ---- 3. native building blocks and ARIA patterns in components ---------------------------------------------------

const probes = [
  ["<dialog>", /<dialog[\s>]/gu],
  ["showModal()", /\.showModal\(\)/gu],
  ["<details>", /<details[\s>]/gu],
  ["<select>", /<select[\s>]/gu],
  ["<table>", /<table[\s>]/gu],
  ["<textarea>", /<textarea[\s>]/gu],
  ['<input type="checkbox">', /type="checkbox"/gu],
  ['<input type="radio">', /type="radio"/gu],
  ['<input type="range">', /type="range"/gu],
  ['<input type="file">', /type="file"/gu],
  ['role="tablist"', /role="tablist"/gu],
  ['role="menu"', /role="menu"/gu],
  ['role="radiogroup"', /role="radiogroup"/gu],
  ['role="radio"', /role="radio"/gu],
  ['role="status"', /role="status"/gu],
  ['role="alert"', /role="alert"/gu],
  ['role="alertdialog"', /role="alertdialog"/gu],
  ['role="log"', /role="log"/gu],
  ["aria-busy", /aria-busy/gu],
  ["aria-pressed", /aria-pressed/gu],
  ["aria-disabled", /aria-disabled/gu],
  ["aria-invalid", /aria-invalid/gu],
  ["aria-live", /aria-live/gu],
  ['className="button', /className=(?:"|\{`|\{")button[\s"`]/gu],
  ['"button primary"', /button primary/gu],
  ['"button secondary"', /button secondary/gu],
  ["button danger", /button[^"`]*\bdanger\b/gu],
  ["button small", /button[^"`]*\bsmall\b/gu],
  ['"text-link"', /text-link/gu],
  ['"icon-button"', /icon-button/gu],
  ["<Icon ", /<Icon\s/gu],
  ["<button", /<button[\s>]/gu],
  ["<Link", /<Link[\s>]/gu],
];
const probeRows = probes.map(([label, pattern]) => {
  let total = 0;
  const files = [];
  for (const c of code) {
    if (!c.file.endsWith(".tsx")) continue;
    const n = (c.text.match(pattern) ?? []).length;
    if (n) {
      total += n;
      files.push(`${c.file} (${n})`);
    }
  }
  return { label, total, files: files.length, fileList: files };
});

// how many <button> elements use the shared .button / .text-link / .icon-button classes vs something else
let buttonsShared = 0;
let buttonsOther = 0;
const otherButtonClasses = new Map();
for (const c of code) {
  if (!c.file.endsWith(".tsx")) continue;
  for (const m of c.text.matchAll(/<(button|Link|a)\b([^>]*?)>/gsu)) {
    const attrs = m[2];
    const cls = attrs.match(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/su);
    if (m[1] !== "button" && !cls) continue;
    const value = cls ? (cls[1] ?? cls[2] ?? cls[3]) : "";
    if (/(^|[\s"'`])(button|text-link|icon-button)([\s"'`]|$)/u.test(value)) buttonsShared += 1;
    else if (m[1] === "button") {
      buttonsOther += 1;
      const key = value.replace(/\s+/gu, " ").trim().slice(0, 60) || "(no class)";
      otherButtonClasses.set(key, (otherButtonClasses.get(key) ?? 0) + 1);
    }
  }
}

// ---- output -------------------------------------------------------------------------------------------------------

const totals = { classes: classes.length, unreferenced: classes.filter((c) => !c.referenced).length };
const result = {
  generatedAt: new Date().toISOString(),
  totals,
  perFile: [...perFile.values()].sort((a, b) => b.unreferenced - a.unreferenced),
  families: familyRows,
  probes: probeRows,
  buttons: { shared: buttonsShared, other: buttonsOther, otherClasses: [...otherButtonClasses.entries()].sort((a, b) => b[1] - a[1]) },
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "components.json"), `${JSON.stringify(result, null, 2)}\n`);

const md = [
  "# Component families and unused selectors, measured from code",
  "",
  `Generated by \`design-audit/tools/ds-components.mjs\` on ${result.generatedAt.slice(0, 10)}.`,
  "",
  `Class selectors found: **${totals.classes}** across ${cssFiles.length} stylesheets. Not mentioned by any .ts/.tsx file: **${totals.unreferenced}** (${Math.round((totals.unreferenced / totals.classes) * 100)}%). "Unreferenced" is a strong hint of dead CSS, not proof.`,
  "",
  "## Unreferenced selectors per stylesheet",
  "",
  "| File | Classes | Unreferenced | Share |",
  "| --- | --- | --- | --- |",
  ...result.perFile.map((r) => `| \`${r.file}\` | ${r.classes} | ${r.unreferenced} | ${Math.round((r.unreferenced / r.classes) * 100)}% |`),
  "",
  "## Component families (class names grouped by keyword)",
  "",
  "| Family | Classes | Still referenced | Stylesheets that define them |",
  "| --- | --- | --- | --- |",
  ...familyRows.map((f) => `| ${f.family} | ${f.classes} | ${f.referenced} | ${f.files} |`),
  "",
  "## Building blocks used by the components (.tsx)",
  "",
  "| Pattern | Uses | Files |",
  "| --- | --- | --- |",
  ...probeRows.map((p) => `| \`${p.label}\` | ${p.total} | ${p.files} |`),
  "",
  `\`<button>\`, \`<Link>\` and \`<a>\` elements styled with a shared class (\`button\`, \`text-link\`, \`icon-button\`): **${buttonsShared}**. \`<button>\` elements styled some other way: **${buttonsOther}**.`,
  "",
  "### Most common non-shared button classes",
  "",
  "| className | Uses |",
  "| --- | --- |",
  ...result.buttons.otherClasses.slice(0, 40).map(([k, n]) => `| \`${k.replace(/\|/gu, "\\|")}\` | ${n} |`),
  "",
  "## Family members",
  "",
  ...familyRows.flatMap((f) => [`### ${f.family} (${f.classes})`, "", ...f.names.map((n) => `- \`${n}\``), ""]),
].join("\n");
writeFileSync(join(outDir, "components.md"), md);
console.log(md.split("## Family members")[0]);
