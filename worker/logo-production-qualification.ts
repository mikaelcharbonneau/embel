import "server-only";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { logoUuidSchema } from "../src/domain/logo-vector";
import { assertSupportedExportRuntime, LOGO_ENGINE_VERSIONS, LOGO_RENDER_POLICY, sha256 } from "../src/features/identity-deliverables/server/render-policy";
import { canonicalIdentityInput } from "../src/features/identity-directions/model/font-check-binding";
import { freezeLogoWorkerManifest, type LogoWorkerCapability } from "./logo-readiness";
import type { LogoProductionRuntimeScope } from "./logo-production-startup";
import { QUALIFIED_VTRACER } from "./logo-vector/engine";
import { qualifyExportSentinel, qualifyVectorSentinel } from "./logo-production-sentinels";
import pins from "./logo-production-runtime-pins.json";

export const LOGO_QUALIFICATION_DEADLINE_MS = 20_000;
export const LOGO_QUALIFICATION_PROOF_TTL_MS = 300_000;
export const LOGO_QUALIFICATION_DRAIN_MS = 5_500;
type Operation = "identity.logo_vectorize" | "identity.logo_export";
export type LogoProductionRuntimeQualificationInput = {
  ownerId: string;
  workerId: string;
  capabilities: readonly LogoWorkerCapability[];
};
const unavailable = () => new Error("Logo production runtime qualification failed.");
const configurationSchema = z.strictObject({ ownerId: logoUuidSchema, workerId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/), capabilities: z.unknown() });
const exportPolicyIdentity = sha256(canonicalIdentityInput({ handlerVersion: "logo-export-v1", renderPolicy: LOGO_RENDER_POLICY, engineVersions: LOGO_ENGINE_VERSIONS }));
function assertCapability(capability: LogoWorkerCapability): asserts capability is LogoWorkerCapability & { operation: Operation } {
  if (capability.provider !== null || capability.model !== null || capability.maxCostMicrousd !== 0 || capability.billingMode !== undefined || capability.policy !== undefined) throw unavailable();
  if (capability.operation === "identity.logo_vectorize") {
    if (capability.handlerVersion !== "1" || capability.engine?.id !== "vtracer" || capability.engine.version !== QUALIFIED_VTRACER.version || capability.engine.artifactHash !== QUALIFIED_VTRACER.wasm) throw unavailable();
  } else if (capability.operation !== "identity.logo_export" || capability.handlerVersion !== "logo-export-v1" || capability.policyIdentity !== exportPolicyIdentity || capability.engine !== null) throw unavailable();
}
/** Fixed reviewed files only. O_NONBLOCK plus regular-file/size checks prevents a
 * substituted FIFO/device from turning a qualification read into an open-ended wait. */
async function readRuntimeFile(path: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 16_777_216) throw unavailable();
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      signal.throwIfAborted();
      const result = await file.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead < 1) throw unavailable();
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs) throw unavailable();
    signal.throwIfAborted();
    return bytes;
  } finally { await file.close(); }
}
async function inspectInstallation(root: string, operation: Operation, signal: AbortSignal): Promise<{ fingerprint: string; bodyFont: Uint8Array; bodyFontLicense: string }> {
  assertSupportedExportRuntime();
  if (process.cwd() !== root) throw unavailable();
  const kind = operation === "identity.logo_vectorize" ? "vector" : "exports";
  const selected = (scope: string) => scope === kind || scope === "both";
  const hashes: string[] = [process.versions.node, process.platform, process.arch, process.execPath];
  let bodyFont = new Uint8Array(), bodyFontLicense = "";
  for (const pin of pins.files.filter(pin => selected(pin.operation))) {
    const bytes = await readRuntimeFile(resolve(root, pin.path), signal), hash = sha256(bytes);
    if (hash !== pin.sha256) throw unavailable();
    hashes.push(`${pin.path}:${hash}`);
    if (pin.path.endsWith("/Geist-Variable.ttf")) bodyFont = new Uint8Array(bytes);
    if (pin.path === "node_modules/geist/LICENSE.txt") bodyFontLicense = new TextDecoder().decode(bytes);
    const pkg = pins.packages.find(pkg => selected(pkg.operation) && pin.path === `node_modules/${pkg.name}/package.json`);
    if (pkg) {
      const manifest: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!manifest || typeof manifest !== "object" || !("version" in manifest) || manifest.version !== pkg.version || !("name" in manifest) || manifest.name !== pkg.name) throw unavailable();
    }
  }
  // Check resolution from both fixed child locations, not just a same-named
  // package under cwd. Conditional import/require entry files are pinned above.
  const fromRoot = createRequire(resolve(root, "package.json"));
  const fromChild = createRequire(resolve(root, kind === "vector" ? "worker/logo-vector/process.ts" : "src/features/identity-deliverables/server/render-process.mjs"));
  for (const pkg of pins.packages.filter(pkg => selected(pkg.operation))) {
    const name = pkg.name === "geist" ? "geist/font/sans" : pkg.name;
    const [expected, actual, packageRoot] = await Promise.all([realpath(fromRoot.resolve(name)), realpath(fromChild.resolve(name)), realpath(resolve(root, "node_modules", pkg.name))]);
    if (expected !== actual || !actual.startsWith(`${packageRoot}${sep}`)) throw unavailable();
    hashes.push(`${pkg.name}:${actual}`); signal.throwIfAborted();
  }
  return { fingerprint: sha256(hashes.join("\n")), bodyFont, bodyFontLicense };
}

/** Pure construction: no timer, file read, subprocess, connection or credential
 * discovery. Only an explicit assertion runs the existing fixed local children.
 * A runtime proof is not an owner/SQL policy, storage or job authorization. */
export function createLogoProductionRuntimeQualification(input: LogoProductionRuntimeQualificationInput) {
  let ownerId: string, workerId: string, capabilities: readonly LogoWorkerCapability[];
  try {
    ({ ownerId, workerId } = configurationSchema.parse(input));
    capabilities = freezeLogoWorkerManifest(input.capabilities);
    if (!capabilities.length || capabilities.length > 2) throw unavailable();
    capabilities.forEach(assertCapability);
  } catch { throw unavailable(); }
  const root = process.cwd(), lifetime = new AbortController();
  const proofs = new Map<Operation, { fingerprint: string; validUntil: number }>();
  const pending = new Set<Promise<void>>();
  const underlying = new Set<Promise<void>>();
  let closed = false, generation = 0, closing: Promise<void> | undefined;
  // One qualification at a time, with no unbounded queue of child launches.
  let active: AbortController | undefined;
  function invalidate(): void { generation++; proofs.clear(); active?.abort(unavailable()); }
  async function assertRuntimeAvailable(scope: LogoProductionRuntimeScope, externalSignal?: AbortSignal): Promise<void> {
    let capability: LogoWorkerCapability;
    try {
      if (closed || active || externalSignal?.aborted || scope?.ownerId !== ownerId || scope.workerId !== workerId) throw unavailable();
      capability = freezeLogoWorkerManifest([scope.capability])[0]!; assertCapability(capability);
      if (!capabilities.some(expected => JSON.stringify(expected) === JSON.stringify(capability))) throw unavailable();
    } catch { throw unavailable(); }
    const operation = capability.operation as Operation, epoch = generation;
    const controller = new AbortController(); active = controller;
    const abort = () => controller.abort(unavailable());
    externalSignal?.addEventListener("abort", abort, { once: true });
    lifetime.signal.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout>;
    const boundary = new Promise<never>((_, reject) => {
      const fail = () => reject(unavailable());
      controller.signal.addEventListener("abort", fail, { once: true });
      timer = setTimeout(abort, LOGO_QUALIFICATION_DEADLINE_MS);
    });
    const work = (async () => {
      const observed = await inspectInstallation(root, operation, controller.signal);
      const previous = proofs.get(operation);
      const executed = !previous || previous.fingerprint !== observed.fingerprint || previous.validUntil <= performance.now();
      if (executed) {
        if (operation === "identity.logo_vectorize") await qualifyVectorSentinel(controller.signal);
        else await qualifyExportSentinel(observed.bodyFont, observed.bodyFontLicense, controller.signal);
        // Recheck after execution so a changed installation never publishes a proof.
        const after = await inspectInstallation(root, operation, controller.signal);
        if (after.fingerprint !== observed.fingerprint) throw unavailable();
      }
      controller.signal.throwIfAborted();
      if (closed || generation !== epoch) throw unavailable();
      // A cache hit never extends the original actual-execution proof lifetime.
      if (!executed && (!previous || previous.validUntil <= performance.now())) throw unavailable();
      proofs.set(operation, !executed && previous ? previous : { fingerprint: observed.fingerprint, validUntil: performance.now() + LOGO_QUALIFICATION_PROOF_TTL_MS });
    })();
    // Retain the active fence until underlying work has settled, even if a
    // caller deadline returns first. A stuck filesystem cannot grow a queue.
    underlying.add(work);
    const release = () => { underlying.delete(work); if (active === controller) active = undefined; };
    void work.then(release, release);
    const result = Promise.race([work, boundary]).catch(() => { proofs.clear(); controller.abort(unavailable()); throw unavailable(); }).finally(() => {
      clearTimeout(timer); externalSignal?.removeEventListener("abort", abort); lifetime.signal.removeEventListener("abort", abort);
    });
    pending.add(result);
    try { await result; } finally { pending.delete(result); }
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true; invalidate(); lifetime.abort(unavailable());
    return closing = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Logo production runtime qualification drain is unconfirmed.")), LOGO_QUALIFICATION_DRAIN_MS);
      void Promise.allSettled([...pending, ...underlying]).then(() => { clearTimeout(timer); resolve(); });
    });
  }
  return Object.freeze({ assertRuntimeAvailable, invalidate, close });
}
