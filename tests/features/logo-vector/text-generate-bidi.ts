/** Offline reproducible Unicode data transformation. No bidi ordering algorithm. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const root = "tests/features/logo-vector/fixtures/unicode/";
const source = readFileSync(root + "DerivedBidiClass-17.0.0.txt"), license = readFileSync(root + "Unicode-LICENSE.txt");
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const sourceSha256 = "4867b4b7f0731ed1bfcd34cc6251211ff1542541fce0734b6fbda139ee80b3a4", licenseSha256 = "e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96";
if (hash(source) !== sourceSha256 || hash(license) !== licenseSha256) throw new Error("Pinned Unicode source or license changed.");
const classes = ["L", "R", "AL", "EN", "ES", "ET", "AN", "CS", "NSM", "BN", "B", "S", "WS", "ON", "LRE", "LRO", "RLE", "RLO", "PDF", "LRI", "RLI", "FSI", "PDI"];
const aliases: Record<string, string> = { Left_To_Right: "L", Right_To_Left: "R", Arabic_Letter: "AL", European_Terminator: "ET" };
const codepoints = new Uint8Array(0x110000); // Unicode's stated default is L; explicit @missing overrides come next.
const lines = source.toString("utf8").split("\n");
function apply(match: RegExpMatchArray) {
  const start = parseInt(match[1]!, 16), end = parseInt(match[2] ?? match[1]!, 16), name = aliases[match[3]!] ?? match[3]!, value = classes.indexOf(name);
  if (value < 0 || start > end || end > 0x10ffff) throw new Error("Unexpected Unicode data.");
  codepoints.fill(value, start, end + 1);
}
for (const line of lines) { const match = line.match(/^# @missing: ([0-9A-F]+)(?:\.\.([0-9A-F]+))?; ([A-Za-z_]+)\s*$/); if (match) apply(match); }
for (const line of lines) { const match = line.match(/^([0-9A-F]+)(?:\.\.([0-9A-F]+))?\s*; ([A-Z]+)\s*#/); if (match) apply(match); }
const ranges: number[][] = [];
for (let start = 0; start < codepoints.length;) {
  let end = start; while (end + 1 < codepoints.length && codepoints[end + 1] === codepoints[start]) end++;
  ranges.push([end, codepoints[start]!]); start = end + 1;
}
const metadata = { unicodeVersion: "17.0.0", sourceUrl: "https://www.unicode.org/Public/17.0.0/ucd/extracted/DerivedBidiClass.txt", sourceSha256, licenseUrl: "https://www.unicode.org/license.txt", licenseSha256, licenseNotice: license.toString("utf8"), rangeFormat: "Sorted inclusive range ends and class indexes, starting at codepoint 0, covering all Unicode codepoints. Official @missing defaults applied before explicit records.", classes };
const output = JSON.stringify(metadata, null, 2).slice(0, -2) + ',\n  "ranges": [\n' + ranges.map(range => "    " + JSON.stringify(range)).join(",\n") + "\n  ]\n}\n";
writeFileSync("worker/logo-vector/text-bidi-data.json", output);
