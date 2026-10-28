import "server-only";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import packages from "../../services/shared-worker/runtime-packages.json";
import filePins from "../../services/shared-worker/runtime-files.json";
import { qualifyExportSentinel, qualifyVectorSentinel } from "../logo-production-sentinels";
import { runLogoTextProcess } from "../logo-vector/text-process";
import { QUALIFIED_HARFBUZZ } from "../logo-vector/text-engine";
import { qualifiedLogoProductionStorageCapability } from "../logo-production-storage-authorization";
import { createLogoProductionRuntimeQualification, preflightLogoProductionRuntimeInstallation, type LogoProductionRuntimeQualification } from "../logo-production-qualification";
import { readDevelopmentConfiguration } from "../../src/server/development/config";
import type { LogoWorkerCapability } from "../logo-readiness";
import { readFreeCatalogFont } from "../../src/features/identity-directions/server/fonts";
import { inspectFontBytes } from "../../src/features/identity-directions/server/font-inspection";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const sharedNativeBuildManifestSchema = z.strictObject({ version: z.literal(2), sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u), sourceClean: z.boolean(),
  indexSha256: digest, rasterSha256: digest, textSha256: digest, renderSha256: digest, runtimePinsSha256: digest, artifactSha256: digest });
const unavailable = () => Error("shared_logo_native_runtime_unavailable");
const expectedPinsHash = hash(JSON.stringify({ packages, files: filePins.files }));
const fontPath = "node_modules/geist/dist/fonts/geist-sans/Geist-Variable.ttf";
const licensePath = "node_modules/geist/LICENSE.txt";

/** Fixed release paths only, no source-tree or Node global lookup fallback. */
async function boundedFile(root: string, relative: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const filename = resolve(root, relative);
  if (!filename.startsWith(root + sep) || await realpath(filename) !== filename) throw unavailable();
  const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > 64_000_000) throw unavailable();
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.byteLength) {
      signal.throwIfAborted(); const result = await file.read(bytes, offset, bytes.byteLength - offset, offset);
      if (!result.bytesRead) throw unavailable(); offset += result.bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw unavailable();
    signal.throwIfAborted(); return bytes;
  } finally { await file.close(); }
}

export async function verifySharedNativeArtifact(signal: AbortSignal) {
  const root = process.cwd();
  if (process.versions.node !== "22.22.2" || process.platform !== "linux" || process.arch !== "x64"
    || await realpath(root) !== root || fileURLToPath(import.meta.url) !== resolve(root, "dist/index.js")) throw unavailable();
  const manifest = sharedNativeBuildManifestSchema.parse(JSON.parse(new TextDecoder().decode(await boundedFile(root, "dist/build-manifest.json", signal))));
  const hashes = { indexSha256: manifest.indexSha256, rasterSha256: manifest.rasterSha256, textSha256: manifest.textSha256, renderSha256: manifest.renderSha256, runtimePinsSha256: manifest.runtimePinsSha256 };
  if (manifest.runtimePinsSha256 !== expectedPinsHash || hash(JSON.stringify(hashes)) !== manifest.artifactSha256) throw unavailable();
  for (const [filename, expected] of [["index.js", manifest.indexSha256], ["raster.js", manifest.rasterSha256], ["text.js", manifest.textSha256], ["render.js", manifest.renderSha256]] as const)
    if (hash(await boundedFile(root, `dist/${filename}`, signal)) !== expected) throw unavailable();
  return manifest;
}

async function inspect(signal: AbortSignal, requireClean: boolean) {
  const root = process.cwd(), manifest = await verifySharedNativeArtifact(signal);
  if (requireClean && manifest.sourceClean !== true) throw unavailable();
  const installed = JSON.parse(new TextDecoder().decode(await boundedFile(root, "dist/runtime-manifest.json", signal)));
  if (installed.version !== 1 || installed.platform !== "linux" || installed.arch !== "x64" || installed.libc !== "glibc"
    || !isDeepStrictEqual(installed.packages, packages) || !isDeepStrictEqual(installed.files, filePins.files)) throw unavailable();
  let bodyFont = new Uint8Array(), bodyFontLicense = "";
  for (const [filename, expected] of Object.entries(filePins.files)) {
    const bytes = await boundedFile(root, filename, signal);
    if (hash(bytes) !== expected) throw unavailable();
    if (filename === fontPath) bodyFont = Uint8Array.from(bytes);
    if (filename === licensePath) bodyFontLicense = new TextDecoder().decode(bytes);
  }
  const fromRoot = createRequire(resolve(root, "package.json"));
  for (const pkg of packages) {
    const packageRoot = resolve(root, "node_modules", pkg.name);
    if (!(await lstat(packageRoot)).isDirectory() || await realpath(packageRoot) !== packageRoot) throw unavailable();
    const name = pkg.name === "geist" ? "geist/font/sans" : pkg.name === "@img/sharp-linux-x64" ? `${pkg.name}/sharp.node`
      : pkg.name === "@img/sharp-libvips-linux-x64" ? `${pkg.name}/binary` : pkg.name;
    const entry = await realpath(fromRoot.resolve(name));
    if (!entry.startsWith(packageRoot + sep)) throw unavailable();
  }
  return { manifest, bodyFont, bodyFontLicense };
}

async function qualifyText(bodyFont: Uint8Array, bodyFontLicense: string, signal: AbortSignal) {
  const id = "00000000-0000-4000-8000-000000000001", contentHash = hash(bodyFont);
  const catalog = await readFreeCatalogFont("geist-sans-variable");
  if (catalog.contentHash !== contentHash || catalog.licenseText !== bodyFontLicense) throw unavailable();
  const inspected = await inspectFontBytes(catalog.bytes, catalog.mimeType, signal);
  if (inspected.family !== "Geist" || [..."Embel"].some(character => !inspected.codePoints.includes(character.codePointAt(0)!))) throw unavailable();
  const asset = { ownerId: id, projectId: id, assetId: id, versionId: id, contentHash };
  const result = await runLogoTextProcess({ source: { text: "Embel", contentKind: "brand_name", font: asset, rightsEvidenceId: catalog.rights.id, faceIndex: 0, size: 32,
    variationAxes: {}, featureTags: {}, language: "en", script: "Latn", direction: "ltr", letterSpacing: 0, lineHeight: 1, shapingEngine: { id: QUALIFIED_HARFBUZZ.id, version: QUALIFIED_HARFBUZZ.version } },
  font: { bytes: bodyFont, contentHash, purpose: "outline", record: { id, asset, family: catalog.family, source: "free_catalog", rights: catalog.rights } } }, signal);
  if (result.glyphs.length !== 5 || !result.paths.length || result.glyphs.some(glyph => !glyph.id || glyph.xAdvance <= 0)) throw unavailable();
}

/** Diagnostic of THIS isolated artifact, including uncommitted local builds.
 * Never a SQL/provider/Storage/activation or approved-clean-release assertion. */
export async function inspectPackagedLogoNativeRuntime(signal: AbortSignal) {
  const before = await inspect(signal, false);
  await qualifyVectorSentinel(signal);
  await qualifyText(before.bodyFont, before.bodyFontLicense, signal);
  await qualifyExportSentinel(before.bodyFont, before.bodyFontLicense, signal);
  const after = await inspect(signal, false);
  if (!isDeepStrictEqual(before.manifest, after.manifest)) throw unavailable();
  return { nativeReady: true, activationReady: false, sourceRevision: before.manifest.sourceRevision, sourceClean: before.manifest.sourceClean,
    artifactSha256: before.manifest.artifactSha256, packages: packages.length, files: Object.keys(filePins.files).length,
    checks: ["vector_wasm", "catalog_fontkit_worker", "harfbuzz_text_child", "png_pdf_render", "independent_pdf_raster", "guidelines_font", "archive"] };
}

export type SharedLogoNativeRuntimeQualification = LogoProductionRuntimeQualification & { preflight(signal?: AbortSignal): Promise<void> };
type NativeScope = Parameters<LogoProductionRuntimeQualification["assertRuntimeAvailable"]>[0];
type SharedNativeInput = { workerId: string; capabilities: readonly LogoWorkerCapability[] };
function nativeInput(input: SharedNativeInput) {
  const workerId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/u).parse(input.workerId);
  const capabilities = input.capabilities.map(raw => qualifiedLogoProductionStorageCapability(raw));
  if (!capabilities.length || capabilities.length > 2 || capabilities.some(cap => !cap)) throw unavailable();
  return { workerId, capabilities: capabilities as LogoWorkerCapability[] };
}
function validScope(scope: Parameters<LogoProductionRuntimeQualification["assertRuntimeAvailable"]>[0], workerId: string, capabilities: readonly LogoWorkerCapability[]) {
  return scope.workerId === workerId && z.uuid().safeParse(scope.ownerId).success && capabilities.some(cap => isDeepStrictEqual(cap, scope.capability));
}

/** One fixed-slot native proof, without customer credentials or owner caches.
 * Job admission/storage/lease authorization remains a separate required proof. */
export function createPackagedLogoProductionRuntimeQualification(input: SharedNativeInput): SharedLogoNativeRuntimeQualification {
  const { workerId, capabilities } = nativeInput(input);
  let closed = false, pending: Promise<void> | null = null, validUntil = 0;
  let active: AbortController | null = null;
  async function preflight(signal?: AbortSignal) {
    if (closed || pending || signal?.aborted) throw unavailable();
    const controller = new AbortController(), abort = () => controller.abort(unavailable());
    active = controller; signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 20_000);
    const boundary = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(unavailable()), { once: true }));
    const work = (async () => {
      const before = await inspect(controller.signal, true);
      if (performance.now() >= validUntil) {
        await qualifyVectorSentinel(controller.signal); await qualifyText(before.bodyFont, before.bodyFontLicense, controller.signal);
        await qualifyExportSentinel(before.bodyFont, before.bodyFontLicense, controller.signal);
        if (!isDeepStrictEqual(before.manifest, (await inspect(controller.signal, true)).manifest)) throw unavailable();
        validUntil = performance.now() + 300_000;
      }
      controller.signal.throwIfAborted(); if (closed) throw unavailable();
    })();
    pending = work;
    const release = () => { pending = null; if (active === controller) active = null; };
    void work.then(release, release);
    try { await Promise.race([work, boundary]); } catch { validUntil = 0; controller.abort(unavailable()); throw unavailable(); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  return Object.freeze({
    preflight,
    async assertRuntimeAvailable(scope: NativeScope, signal?: AbortSignal) {
      if (!validScope(scope, workerId, capabilities)) throw unavailable();
      await preflight(signal);
    },
    invalidate() { validUntil = 0; active?.abort(unavailable()); },
    async close() {
      closed = true; validUntil = 0; active?.abort(unavailable());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.allSettled(pending ? [pending] : []), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("shared_logo_native_drain_unconfirmed")), 5_500); })]); }
      finally { clearTimeout(timer); }
    },
  });
}

/** Development is selected explicitly by the validated loopback target. Every
 * actual assertion creates and drains the unchanged owner-bound source probe;
 * no owner registry, credentials, production fallback or unbounded cache. */
export function createDevelopmentSharedLogoProductionRuntimeQualification(input: SharedNativeInput): SharedLogoNativeRuntimeQualification {
  if (!readDevelopmentConfiguration()) throw unavailable();
  const { workerId, capabilities } = nativeInput(input);
  let closed = false, pending: Promise<void> | null = null, active: LogoProductionRuntimeQualification | null = null;
  let activeController: AbortController | null = null;
  const lifetime = new AbortController();
  async function run(scope: Parameters<LogoProductionRuntimeQualification["assertRuntimeAvailable"]>[0] | null, signal?: AbortSignal) {
    if (closed || pending || signal?.aborted || !readDevelopmentConfiguration()) throw unavailable();
    const controller = new AbortController(), abort = () => controller.abort(unavailable());
    activeController = controller;
    lifetime.signal.addEventListener("abort", abort, { once: true }); signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 20_000);
    const boundary = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(unavailable()), { once: true }));
    const work = (async () => {
      if (scope) {
        const probe = createLogoProductionRuntimeQualification({ ownerId: scope.ownerId, workerId, capabilities: [scope.capability] }); active = probe;
        try { await probe.assertRuntimeAvailable(scope, controller.signal); } finally { await probe.close(); active = null; }
      } else await preflightLogoProductionRuntimeInstallation(capabilities, controller.signal);
      controller.signal.throwIfAborted(); if (closed) throw unavailable();
    })();
    pending = work; const release = () => { pending = null; if (activeController === controller) activeController = null; }; void work.then(release, release);
    try { await Promise.race([work, boundary]); } catch { throw unavailable(); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); lifetime.signal.removeEventListener("abort", abort); }
  }
  return Object.freeze({
    preflight: (signal?: AbortSignal) => run(null, signal),
    async assertRuntimeAvailable(scope: NativeScope, signal?: AbortSignal) {
      if (!validScope(scope, workerId, capabilities)) throw unavailable(); await run(scope, signal);
    },
    invalidate() { activeController?.abort(unavailable()); active?.invalidate(); },
    async close() {
      closed = true; lifetime.abort(unavailable()); active?.invalidate();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.allSettled(pending ? [pending] : []), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("shared_logo_native_drain_unconfirmed")), 5_500); })]); }
      finally { clearTimeout(timer); }
    },
  });
}
