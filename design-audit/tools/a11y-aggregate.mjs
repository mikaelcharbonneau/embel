// Design-audit pass 3: folds the per-route probe files (evidence/a11y/*.json) into one overview.
//   node design-audit/tools/a11y-aggregate.mjs [section]     sections: contrast edges targets focus axe reflow forms doc hover
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../evidence/a11y");
const files = readdirSync(DIR).filter((f) => /__\d+\.json$/u.test(f));
const all = files.map((f) => JSON.parse(readFileSync(path.join(DIR, f), "utf8")));
const want = process.argv[2];
const section = (name, fn) => {
  if (want && want !== name) return;
  console.log(`\n===== ${name} =====`);
  fn();
};
const short = (slug) => slug.replace(/^brand-conversation__/u, "conv:").replace(/__/u, ":");
const fold = (rows, keyOf, init) => {
  const map = new Map();
  for (const [row, page] of rows) {
    const key = keyOf(row);
    const entry = map.get(key) ?? { ...init(row), pages: new Set(), count: 0 };
    entry.pages.add(`${short(page.slug)}@${page.width}`);
    entry.count += row.count ?? 1;
    map.set(key, entry);
  }
  return [...map.values()];
};
const pages = (set, n = 4) => `${set.size} page-widths, e.g. ${[...set].slice(0, n).join(", ")}`;

section("contrast", () => {
  const rows = all.flatMap((p) => (p.contrast ?? []).map((c) => [c, p]));
  const folded = fold(rows, (c) => `${c.fg}|${c.bg}|${c.size}|${c.weight}|${c.disabled}|${c.placeholder ?? ""}`, (c) => ({ ...c })).sort((a, b) => a.ratio - b.ratio);
  console.log(`distinct text colour pairs: ${folded.length}; failing (not disabled): ${folded.filter((c) => !c.pass && !c.disabled).length}`);
  for (const c of folded.filter((c) => c.ratio < 7))
    console.log(`${c.pass ? "pass" : c.disabled ? "DISABLED" : "FAIL"} ${String(c.ratio).padEnd(5)} need ${c.required}  ${c.fg} on ${c.bg}  ${c.size}px/${c.weight}${c.placeholder ? " placeholder" : ""}${c.bgImage ? " (bg image)" : ""}${c.opacity ? ` opacity ${c.opacity}` : ""}  x${c.count}  ${pages(c.pages, 3)}\n      ${c.samples.slice(0, 2).join("\n      ")}`);
});

section("edges", () => {
  const rows = all.flatMap((p) => (p.edges ?? []).map((e) => [e, p]));
  const folded = fold(rows, (e) => `${e.kind}|${e.fill}|${e.border}|${e.outside}`, (e) => ({ ...e })).sort((a, b) => a.best - b.best);
  for (const e of folded.filter((e) => e.best < 4.5))
    console.log(`${e.pass ? "pass" : "FAIL"} best ${String(e.best).padEnd(5)} ${e.kind} fill ${e.fill} (${e.fillRatio}) border ${e.border} (${e.borderRatio}) on ${e.outside}  x${e.count}  ${pages(e.pages, 3)}\n      ${e.samples.slice(0, 3).join(" | ")}`);
});

section("targets", () => {
  const rows = all.flatMap((p) => (p.targets?.under24 ?? []).map((t) => [t, p]));
  const folded = fold(rows, (t) => `${t.target.replace(/"[^"]*"/u, "")}|${Math.round(t.width)}x${Math.round(t.height)}`, (t) => ({ ...t }));
  for (const t of folded.sort((a, b) => Number(b.fails258) - Number(a.fails258)))
    console.log(`${t.fails258 ? "FAIL 2.5.8" : t.inline ? "inline (exempt)" : "under 24, spaced"}  ${t.width}x${t.height}  ${t.target}  in ${t.where}${t.crowdedBy ? `  crowded by ${t.crowdedBy}` : ""}  x${t.count}  ${pages(t.pages, 3)}`);
  console.log("\nunder 44 px (either side), per page:");
  for (const p of all.sort((a, b) => a.slug.localeCompare(b.slug))) if (p.targets) console.log(`  ${short(p.slug)}@${p.width}: ${p.targets.under44} of ${p.targets.total}`);
});

section("focus", () => {
  const rows = all.flatMap((p) => (p.walk ?? []).map((w) => [w, p]));
  const byIndicator = fold(rows, (w) => `${w.indicator.replace(/rgba?\([^)]*\)/gu, "C")}|${w.indicatorRatio}|${w.behind}`, (w) => ({ indicator: w.indicator, ratio: w.indicatorRatio, behind: w.behind, sample: w.el }));
  for (const f of byIndicator.sort((a, b) => b.count - a.count)) console.log(`x${String(f.count).padEnd(5)} ${f.indicator}  ratio ${f.ratio} on ${f.behind}  e.g. ${f.sample}  (${pages(f.pages, 2)})`);
  console.log("\ninvisible or zero-size focus stops:");
  for (const f of fold(rows.filter(([w]) => w.invisible), (w) => w.el, (w) => ({ el: w.el, where: w.where, size: `${w.w}x${w.h}` }))) console.log(`  ${f.el} ${f.size} in ${f.where}  x${f.count} (${pages(f.pages, 3)})`);
  console.log("\nfocused control covered by another layer (>=3 of 5 sample points):");
  for (const f of fold(rows.filter(([w]) => w.covered >= 3), (w) => `${w.el.replace(/"[^"]*"/u, "").replace(/\[[^\]]*\]/u, "")}|${w.coveredBy}`, (w) => ({ el: w.el, where: w.where, by: w.coveredBy, covered: w.covered, outside: w.outside }))) console.log(`  ${f.el} in ${f.where}  covered by ${f.by} (${f.covered}/5)  x${f.count} (${pages(f.pages, 3)})`);
  console.log("\nfocused control left outside the viewport (>=3 of 5 points):");
  for (const f of fold(rows.filter(([w]) => w.outside >= 3), (w) => w.el.replace(/"[^"]*"/u, ""), (w) => ({ el: w.el, where: w.where }))) console.log(`  ${f.el} in ${f.where}  x${f.count} (${pages(f.pages, 3)})`);
  console.log("\nnot :focus-visible after Tab:");
  for (const f of fold(rows.filter(([w]) => !w.focusVisible), (w) => w.el.replace(/"[^"]*"/u, ""), (w) => ({ el: w.el }))) console.log(`  ${f.el} x${f.count}`);
  console.log("\ntruncated walks:", all.filter((p) => p.walkTruncated).map((p) => `${short(p.slug)}@${p.width}`).join(", ") || "none");
});

section("axe", () => {
  const rows = all.flatMap((p) => (p.axe?.violations ?? []).map((v) => [v, p]));
  for (const v of fold(rows, (v) => v.id, (v) => ({ ...v })).sort((a, b) => b.pages.size - a.pages.size)) {
    console.log(`${v.id} [${v.impact}] ${v.tags.join(",")}  ${v.help}  (${pages(v.pages, 5)})`);
    for (const n of v.nodes.slice(0, 3)) console.log(`      ${n.target}\n        ${n.html}\n        ${n.why}`);
  }
  const inc = all.flatMap((p) => (p.axe?.incomplete ?? []).map((v) => [v, p]));
  console.log("\nincomplete (needs a human):");
  for (const v of fold(inc, (v) => v.id, (v) => ({ ...v }))) console.log(`  ${v.id}: ${v.help} (${pages(v.pages, 2)})`);
});

section("reflow", () => {
  for (const p of all.filter((p) => p.reflow).sort((a, b) => a.slug.localeCompare(b.slug))) {
    for (const [name, r] of Object.entries(p.reflow)) {
      const fixed = r.fixedLayers.map((f) => `${f.layer.slice(0, 40)} ${f.shareOfViewport}%`).join("; ");
      if (r.overflowX > 0 || r.offenders.length || r.fixedLayers.some((f) => f.shareOfViewport >= 20)) console.log(`${short(p.slug)} ${name}: overflowX ${r.overflowX}, min font ${r.minFontSize}px, fixed: ${fixed}\n      ${r.offenders.slice(0, 4).join("\n      ")}`);
    }
  }
});

section("forms", () => {
  const rows = all.flatMap((p) => (p.fields ?? []).map((f) => [f, p]));
  for (const f of fold(rows, (f) => `${f.field}|${f.disabled}`, (f) => ({ ...f }))) console.log(`${f.field}  type=${f.type} label=${JSON.stringify(f.label)} autocomplete=${f.autocomplete} inputmode=${f.inputmode} required=${f.required} describedby=${f.describedBy} font=${f.fontSize}px disabled=${f.disabled}  (${pages(f.pages, 2)})`);
});

section("doc", () => {
  for (const p of all.filter((p) => p.width === 1440 && p.doc).sort((a, b) => a.slug.localeCompare(b.slug)))
    console.log(`${short(p.slug)}: title=${JSON.stringify(p.doc.title)} lang=${p.doc.lang} h1=${JSON.stringify(p.doc.h1)} main=${p.doc.landmarks.main} nav=${JSON.stringify(p.doc.navLabels)} skip=${JSON.stringify(p.doc.skipLink)} live=${p.doc.liveRegions} viewport=${p.doc.viewportMeta}\n      headings: ${p.doc.headings.slice(0, 14).join(" | ")}`);
});

section("hover", () => {
  const rows = all.flatMap((p) => (p.hover ?? []).map((h) => [h, p]));
  for (const h of fold(rows, (h) => `${h.kind}|${h.hovered.fg}|${h.hovered.bg}`, (h) => ({ ...h })).sort((a, b) => a.hovered.ratio - b.hovered.ratio).filter((h) => h.hovered.ratio < 7 || !h.changes).slice(0, 60))
    console.log(`${h.hovered.ratio < (h.hovered.size >= 24 ? 3 : 4.5) ? "FAIL" : "ok  "} ${h.kind}: rest ${h.rest.fg}/${h.rest.bg} ${h.rest.ratio} -> hover ${h.hovered.fg}/${h.hovered.bg} ${h.hovered.ratio}${h.changes ? "" : "  (no colour change on hover)"} cursor ${h.hovered.cursor} (${pages(h.pages, 2)})`);
});
