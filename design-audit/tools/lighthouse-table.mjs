// Design-audit pass 3: one table from every Lighthouse report in evidence/lighthouse/<slug>__<device>/report.json.
//   node design-audit/tools/lighthouse-table.mjs            markdown table
//   node design-audit/tools/lighthouse-table.mjs --fails    every failed audit, folded across pages
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../evidence/lighthouse");
const rows = new Map();
const fails = new Map();
for (const dir of readdirSync(DIR).sort()) {
  const file = path.join(DIR, dir, "report.json");
  if (!existsSync(file)) continue;
  const m = /^(.*)__(desktop|mobile)$/u.exec(dir);
  if (!m) continue;
  const lhr = JSON.parse(readFileSync(file, "utf8"));
  const score = (id) => (lhr.categories?.[id]?.score == null ? "n/a" : Math.round(lhr.categories[id].score * 100));
  const row = rows.get(m[1]) ?? {
    url: (lhr.finalDisplayedUrl ?? lhr.requestedUrl ?? "")
      .replace(/^https?:\/\/[^/]+/u, "")
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/u, "<id>"),
    mode: lhr.gatherMode,
  };
  const failed = Object.values(lhr.audits).filter(
    (a) =>
      a.score !== null &&
      a.score < 0.9 &&
      a.scoreDisplayMode !== "informative" &&
      a.scoreDisplayMode !== "notApplicable" &&
      a.scoreDisplayMode !== "manual",
  );
  const inCategory = (id) => new Set((lhr.categories?.[id]?.auditRefs ?? []).map((r) => r.id));
  const a11y = inCategory("accessibility");
  const bp = inCategory("best-practices");
  const cls = lhr.audits["cumulative-layout-shift"]?.numericValue;
  row[m[2]] = {
    a11y: score("accessibility"),
    bp: score("best-practices"),
    cls: cls == null ? "" : cls.toFixed(3),
    failed: failed.filter((a) => a11y.has(a.id) || bp.has(a.id)).map((a) => a.id),
  };
  rows.set(m[1], row);
  for (const a of failed.filter((a) => a11y.has(a.id) || bp.has(a.id))) {
    const entry = fails.get(a.id) ?? { title: a.title, pages: new Set(), nodes: new Map(), detail: new Set() };
    entry.pages.add(dir);
    for (const item of a.details?.items ?? []) {
      if (item.node?.snippet) entry.nodes.set(item.node.selector, item.node.snippet.slice(0, 200));
      else if (item.description || item.sourceLocation?.url)
        entry.detail.add(
          `${item.description ?? ""} ${item.sourceLocation?.url ?? ""}`
            .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gu, "<id>")
            .slice(0, 220),
        );
    }
    fails.set(a.id, entry);
  }
}
if (process.argv.includes("--fails")) {
  for (const [id, f] of fails) {
    console.log(`\n${id}: ${f.title}\n  pages (${f.pages.size}): ${[...f.pages].join(", ")}`);
    for (const [sel, snip] of [...f.nodes].slice(0, 5)) console.log(`  node: ${sel}\n        ${snip}`);
    for (const d of [...f.detail].slice(0, 6)) console.log(`  detail: ${d}`);
  }
} else {
  console.log(
    "| Route state | URL | Accessibility (desktop / mobile) | Best practices (desktop / mobile) | Layout shift, dev server (desktop / mobile) | Failed audits |",
  );
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const [slug, r] of rows) {
    const d = r.desktop ?? {};
    const mo = r.mobile ?? {};
    const failed = [...new Set([...(d.failed ?? []), ...(mo.failed ?? [])])].join(", ") || "none";
    console.log(
      `| \`${slug}\`${r.mode === "snapshot" ? " (snapshot mode)" : ""} | \`${r.url}\` | ${d.a11y ?? "-"} / ${mo.a11y ?? "-"} | ${d.bp ?? "-"} / ${mo.bp ?? "-"} | ${d.cls ?? ""} / ${mo.cls ?? ""} | ${failed} |`,
    );
  }
}
