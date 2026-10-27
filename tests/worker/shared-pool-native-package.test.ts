import { afterEach, describe, expect, it, vi } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installSharedRuntimePackages, readSharedRuntimeFilePins, readSharedRuntimePackages } from "../../services/shared-worker/package-runtime.mjs";
import { createPackagedLogoProductionRuntimeQualification } from "../../worker/shared-pool/logo-native-qualification";
vi.mock("server-only", () => ({}));

const roots: string[] = [];
async function source() {
  const root = await mkdtemp(path.join(tmpdir(), "embel-native-package-unit-")); roots.push(root);
  for (const relative of ["package-lock.json", "services/logo-worker/runtime-packages.json", "services/shared-worker/runtime-packages.json", "services/shared-worker/runtime-files.json"]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await cp(relative, path.join(root, relative));
  }
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("shared native package source guards (hermetic, no native execution claim)", () => {
  it("pins the full dynamic runtime closure and actual data/binaries/licenses", async () => {
    const root = await source(), pins = await readSharedRuntimePackages(root), files = await readSharedRuntimeFilePins(root);
    expect(pins).toHaveLength(33);
    expect(pins.slice(0, 6)).toEqual(JSON.parse(await readFile("services/logo-worker/runtime-packages.json", "utf8")));
    expect(Object.keys(files)).toHaveLength(2023);
    for (const filename of ["@visioncortex/vtracer/pkg/vtracer_wasm_bg.wasm", "harfbuzzjs/dist/harfbuzz.wasm", "@resvg/resvg-js-linux-x64-gnu/resvgjs.linux-x64-gnu.node",
      "@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node", "pdfkit/js/data/Helvetica.afm", "pdfjs-dist/legacy/build/pdf.worker.mjs", "fontkit/dist/main.cjs", "geist/dist/fonts/geist-sans/Geist-Variable.ttf", "geist/LICENSE.txt"])
      expect(files["node_modules/" + filename]).toMatch(/^[a-f0-9]{64}$/u);
    expect(pins.some(pin => pin.name === "tsx" || pin.name === "next")).toBe(false);
  });
  it.each(["lock", "extra_package", "missing_package", "file_manifest", "symlink"])("refuses %s drift before any download", async kind => {
    const root = await source(), pinsPath = path.join(root, "services/shared-worker/runtime-packages.json");
    if (kind === "lock") { const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")); lock.packages["node_modules/harfbuzzjs"].version = "0.0.0"; await writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock)); }
    if (kind === "extra_package" || kind === "missing_package") { const pins = JSON.parse(await readFile(pinsPath, "utf8")); if (kind === "extra_package") pins.push(pins[0]); else pins.pop(); await writeFile(pinsPath, JSON.stringify(pins)); }
    if (kind === "file_manifest") await writeFile(path.join(root, "services/shared-worker/runtime-files.json"), '{"version":1,"files":{}}');
    if (kind === "symlink") { await rm(pinsPath); await symlink(path.join(root, "services/logo-worker/runtime-packages.json"), pinsPath); }
    const download = vi.fn();
    await expect(installSharedRuntimePackages(root, path.join(root, "release"), { download })).rejects.toThrow();
    expect(download).not.toHaveBeenCalled();
  });
  it("rejects an invalid compressed archive without writing runtime files", async () => {
    const root = await source(), download = vi.fn(async () => new Uint8Array([1, 2, 3]));
    await expect(installSharedRuntimePackages(root, path.join(root, "release"), { download })).rejects.toThrow("verification");
    expect(download).toHaveBeenCalledTimes(1);
  });
  it("does not qualify workspace modules or accept a runtime from environment flags", async () => {
    const source = await readFile("worker/shared-pool/logo-native-qualification.ts", "utf8");
    expect(source).not.toMatch(/process\.env|tsx|NODE_PATH/u);
    const qualification = createPackagedLogoProductionRuntimeQualification({ workerId: "native-package-unit", capabilities: [{ operation: "identity.logo_vectorize", handlerVersion: "1", policyIdentity: "a".repeat(64), provider: null, model: null, maxCostMicrousd: 0,
      engine: { id: "vtracer", version: "1.0.0-alpha.4", artifactHash: "63716b70497b7468ef97545b50f5f34b8bbb7acde2d7b00deb4eb40781446d45" } }] });
    await expect(qualification.assertRuntimeAvailable({ ownerId: "00000000-0000-4000-8000-000000000001", workerId: "native-package-unit", capability: { operation: "identity.logo_vectorize", handlerVersion: "1", policyIdentity: "a".repeat(64), provider: null, model: null, maxCostMicrousd: 0,
      engine: { id: "vtracer", version: "1.0.0-alpha.4", artifactHash: "63716b70497b7468ef97545b50f5f34b8bbb7acde2d7b00deb4eb40781446d45" } } })).rejects.toThrow("shared_logo_native_runtime_unavailable");
    await qualification.close();
  });
});
