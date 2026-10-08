/** Explicit local qualification artifacts only. No provider, account or hosted storage is used. */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { buildLogoExport } from "../../../src/features/identity-deliverables/server/package";
import { renderLogoFiles } from "../../../src/features/identity-deliverables/server/render-logo";
import { verifyLogoFiles } from "../../../src/features/identity-deliverables/server/verify-output";
import { computeLogoVariantRenderHash } from "../../../src/features/identity-deliverables/server/render-policy";
import { validateVariantReview } from "../../../src/features/identity-deliverables/model/variants";
import { approvedExportFixture, resolvedFixture, syntheticDocument, types, hashBytes } from "./fixtures";
const destination = path.resolve("docs/evidence/logo-exports/synthetic");
await mkdir(destination, { recursive: true });
const input = await approvedExportFixture(), signal = new AbortController().signal;
const prepared = await buildLogoExport(input, signal), files = [...prepared.files, prepared.archive];
for (const file of files) await writeFile(path.join(destination, file.name), file.bytes);
const observations = [];
for (const type of types) {
  const fixture = resolvedFixture(syntheticDocument(type), computeLogoVariantRenderHash), source = validateVariantReview(fixture.resolved, fixture.review)[2]!;
  const rendered = await renderLogoFiles(source, { pngLongEdge: 512 }, signal), verification = await verifyLogoFiles(rendered, source, { pngLongEdge: 512 });
  for (const format of ["svg", "pdf", "png"] as const) await writeFile(path.join(destination, `synthetic-${type}.${format}`), rendered[format]);
  observations.push({ type, verification });
}
const white = files.find(file => file.name.startsWith("primary-white") && file.mimeType === "image/png")!;
await writeFile(path.join(destination, "synthetic-white-on-dark.png"), await sharp(white.bytes).flatten({ background: "#18202C" }).png().toBuffer());
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const dependencyEvidence = [];
for (const name of ["pdfkit", "@resvg/resvg-js", "pdfjs-dist", "sharp", "fflate", "@napi-rs/canvas", "fontkit", "geist"]) {
  const pkg = JSON.parse(await readFile(path.join("node_modules", name, "package.json"), "utf8"));
  dependencyEvidence.push({ name, version: pkg.version, license: pkg.license, engines: pkg.engines ?? null, integrity: lock.packages[`node_modules/${name}`].integrity });
}
await writeFile(path.join(destination, "qualification.json"), JSON.stringify({ corpus: "original synthetic geometry, not live provider output", node: process.versions.node, dependencyEvidence, sourceSnapshotHash: prepared.sourceSnapshotHash, files: files.map(file => ({ name: file.name, contentHash: hashBytes(file.bytes), byteLength: file.bytes.byteLength, mimeType: file.mimeType })), observations }, null, 2));
console.log(JSON.stringify({ saved: files.length + 23, directory: destination, formats: ["SVG paths", "PDF vectors", "PNG alpha", "guidelines PDF", "ZIP"], cases: observations.length }));
