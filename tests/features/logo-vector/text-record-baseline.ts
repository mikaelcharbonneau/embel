/** Offline qualification utility; never imported by production or invoked by tests. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as hb from "harfbuzzjs";
import { canonicalizeLogoPath, encodeLogoPath } from "../../../src/features/logo-vector/model/geometry";
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const recordings = [
  { file: "node_modules/geist/dist/fonts/geist-sans/Geist-Variable.ttf", expectedHash: "cdcc4815cbf5f9882fa74e48f8ab410a0495781a58ff7316570f664e7e987753", text: ["A\u0301", "fi", "A\u0323\u0301B", "AV"], script: "Latn", language: "en", direction: "ltr" },
  { file: "tests/features/logo-vector/fixtures/fonts/NotoSansArabic-variable.ttf", expectedHash: "63111b5b2e074dd48cc67692e0a2726d86ee94c1c37fe8598257b7b4e87e869e", text: ["سلام", "سَلَام"], script: "Arab", language: "ar", direction: "rtl" },
];
if (hb.versionString() !== "14.5.0") throw new Error("Unexpected HarfBuzz core.");
const samples = recordings.flatMap(record => {
  const bytes = readFileSync(record.file);
  if (hash(bytes) !== record.expectedHash) throw new Error("Unexpected font bytes.");
  const face = new hb.Face(new hb.Blob(bytes), 0), font = new hb.Font(face);
  font.setScale(face.upem, face.upem); font.setVariations([]);
  return record.text.map(text => {
    const buffer = new hb.Buffer(); buffer.addText(text); buffer.setClusterLevel(hb.ClusterLevel.MONOTONE_GRAPHEMES);
    buffer.setScript(record.script); buffer.setDirection(record.direction === "rtl" ? hb.Direction.RTL : hb.Direction.LTR); buffer.setLanguage(record.language);
    hb.shape(font, buffer, []);
    return { text, fontSha256: hash(bytes), script: record.script, language: record.language, direction: record.direction, faceIndex: 0, variationAxes: {}, featureTags: {}, clusterLevel: "MONOTONE_GRAPHEMES", upem: face.upem,
      glyphs: buffer.getGlyphInfosAndPositions().map(({ codepoint, cluster, xAdvance, yAdvance, xOffset, yOffset }) => ({ id: codepoint, cluster, xAdvance, yAdvance, xOffset, yOffset })),
      outlineSha256: buffer.getGlyphInfos().map(g => hash(font.glyphToPath(g.codepoint))),
      canonicalOutlineSha256: buffer.getGlyphInfos().map(g => hash(encodeLogoPath(canonicalizeLogoPath(font.glyphToPath(g.codepoint))))),
    };
  });
});
writeFileSync("tests/features/logo-vector/fixtures/fonts/harfbuzz-1.6.2-baseline.json", JSON.stringify({ note: "Independently recorded through direct HarfBuzz classes, without the Fluid text adapter. Metrics and isolated outline digests use unscaled y-up font units; no text normalization.", harfbuzzjs: "1.6.2", harfbuzzCore: hb.versionString(), samples }, null, 2) + "\n");
