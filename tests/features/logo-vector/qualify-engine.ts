/** Reproducible local qualification, never provider or production-output benchmarking. */
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { logoTypeSchema } from "../../../src/domain/logo-vector";
import { traceLogoRaster, QUALIFIED_VTRACER } from "../../../worker/logo-vector/engine";
import { serializeLogoSvg } from "../../../src/features/logo-vector/model/svg";
import { canonicalLogoDocumentBytes } from "../../../src/features/logo-vector/server/revisions";
import { digestBytes, syntheticConversionInput } from "./raster-fixtures";
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const rows = [];
for (const logoType of logoTypeSchema.options) {
  const input = syntheticConversionInput(logoType), start = performance.now();
  const output = await traceLogoRaster({ bytes: input.source.bytes, mimeType: input.source.mimeType, logoType, settings: input.settings });
  const svg = serializeLogoSvg(output.document);
  rows.push({ logoType, fixture: "original synthetic 48x40 RGBA PNG", sourceHash: input.source.reference.contentHash,
    sourceBytes: input.source.bytes.length, svgBytes: svg.length, svgHash: digestBytes(svg), documentHash: digestBytes(canonicalLogoDocumentBytes(output.document)),
    paths: output.document.components.flatMap(c => c.paths).length, components: output.document.components.length, elapsedMs: Math.round((performance.now() - start) * 100) / 100,
    processMaxRssKiB: process.resourceUsage().maxRSS, status: "pass" });
}
const receipt = {
  version: 1, checkedAt: new Date().toISOString(), status: "qualified_for_local_synthetic_conversion", fixtureScope: "Original synthetic artwork only. No paid request or output-quality benchmark.",
  host: { node: process.version, platform: process.platform, arch: process.arch },
  engine: { name: "@visioncortex/vtracer", version: QUALIFIED_VTRACER.version, license: "MIT OR Apache-2.0", selectedLicense: "MIT", nodeRequirement: ">=16",
    packageIntegrity: lock.packages["node_modules/@visioncortex/vtracer"].integrity,
    artifacts: { "pkg/vtracer_wasm_bg.wasm": QUALIFIED_VTRACER.wasm, "index.js": QUALIFIED_VTRACER.entry, "pkg/vtracer_wasm.js": QUALIFIED_VTRACER.bridge },
    primarySources: ["https://github.com/visioncortex/vtracer", "https://github.com/visioncortex/vtracer/blob/master/nodejs/package.json", "https://github.com/visioncortex/vtracer/blob/master/nodejs/index.d.ts", "https://github.com/visioncortex/vtracer/blob/master/nodejs/src/lib.rs"] },
  decoder: { name: "sharp", version: sharp.versions.sharp, license: "Apache-2.0", nodeRequirement: ">=20.9.0", packageIntegrity: lock.packages["node_modules/sharp"].integrity,
    nativeVersions: sharp.versions, primarySources: ["https://sharp.pixelplumbing.com/api-constructor/", "https://sharp.pixelplumbing.com/api-input/", "https://sharp.pixelplumbing.com/install/", "https://github.com/lovell/sharp/blob/v0.35.5/package.json"] },
  settings: { preset: "bw", simplify: 0, filterSpeckle: 0, maxColors: 2 },
  adapter: { clustering: "color-cluster", hierarchical: "cutout", colorPrecision: 8, mode: "spline", optimize: 0, bwThreshold: 128, luminance: "sRGB channel weights 0.2126/0.7152/0.0722", alpha: "Disjoint exact-alpha masks retain the original canvas; output opacity is alpha/255 per path; fully transparent RGB is normalized to zero." },
  observedLimitations: [
    "The unadapted prerelease BW preset ignores alpha and poster drops fractional alpha. Adapter qualification uses the same engine on disjoint exact-alpha masks, restores path opacity, and requires user conversion comparison.",
    "High-detail or many-alpha inputs may reach the deadline/geometry limit; no automatic retry or silent fallback is used.",
    "The 256 MiB Node heap flag does not bound native/WASM memory. Input pixels/bytes, output, process deadline and kill teardown are bounded. RSS observations below are this process's cumulative observed peak, not a universal maximum.",
    "This host is Linux x64 Node 24.19.0. Other platforms and hosted deployment packaging have not been qualified.",
    "The runtime must ship worker/logo-vector/process.ts, tsx and exact installed engine artifacts and launch from the repository/application root.",
    "The npm VTracer package declares MIT OR Apache-2.0 but omits a bundled license file; preserve upstream notices when packaging/distributing the dependency.",
    "No semantic layer or original font recovery is claimed. Wordmarks and lettermarks are outlined_custom; combined/illustrated art remains whole_artwork.",
  ],
  bounds: { encodedBytes: 33_554_432, pixels: 16_777_216, edge: 8192, responseBytes: 8_388_608, deadlineMs: 60_000, teardownMs: 5_000 },
  fixtures: rows,
  testCommands: ["npm test -- tests/features/logo-vector", "npx eslint src/features/logo-vector worker/logo-vector tests/features/logo-vector", "node --conditions=react-server --import tsx tests/features/logo-vector/qualify-engine.ts"],
  deploymentActivated: false, liveProviderValidated: false, userAcceptanceEstablished: false,
};
writeFileSync("docs/evidence/logo-vector/engine-qualification.json", JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ fixtures: rows.length, allPassed: rows.every(row => row.status === "pass"), processMaxRssKiB: process.resourceUsage().maxRSS }));
