import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { artifactManifest, checkedInputPath, inputProvenance, validatedSourceRevision } from "../../scripts/lib/api-text-build-manifest.mjs";
import { buildApiTextWorker } from "../../scripts/build-api-text-worker.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const folders: string[] = [];
async function folder() { const value = await mkdtemp(path.join(tmpdir(), "embel-api-manifest-")); folders.push(value); return value; }
afterAll(async () => { await Promise.all(folders.map(value => rm(value, { recursive: true, force: true }))); });

describe("isolated API worker build provenance", () => {
  it("does not invent a source revision and rejects non-Git metadata", () => {
    expect(validatedSourceRevision(undefined)).toBeNull(); expect(validatedSourceRevision("a".repeat(40))).toBe("a".repeat(40));
    expect(() => validatedSourceRevision("main")).toThrow(); expect(() => validatedSourceRevision("SYNTHETIC_SECRET")).toThrow();
  });
  it("rejects protected/outside inputs before reading them", () => {
    for (const input of [".env", ".env.production", ".vercel/project.json", ".aws/credentials", "../outside.txt"]) {
      expect(() => checkedInputPath(root, input)).toThrow("Protected build input rejected");
    }
    expect(checkedInputPath(root, "scripts/certs/supabase-prod-ca-2021.crt?raw").relative).toBe("scripts/certs/supabase-prod-ca-2021.crt");
  });
  it("fingerprints the tracked source and package lock without output-directory or timestamp inputs", async () => {
    const source = await folder(); const { mkdir, copyFile } = await import("node:fs/promises");
    for (const file of ["scripts/build-api-text-worker.mjs", "scripts/lib/api-text-build-manifest.mjs", "services/api-text-worker/vercel.json", "package.json", "package-lock.json"]) {
      await mkdir(path.dirname(path.join(source, file)), { recursive: true }); await copyFile(path.join(root, file), path.join(source, file));
    }
    await writeFile(path.join(source, "fixture.ts"), "export const version = 1;\n");
    const first = await inputProvenance(source, ["fixture.ts"], undefined);
    expect(await inputProvenance(source, ["fixture.ts"], undefined)).toEqual(first);
    await writeFile(path.join(source, "fixture.ts"), "export const version = 2;\n");
    const changedSource = await inputProvenance(source, ["fixture.ts"], undefined);
    expect(changedSource.sourceFingerprint).not.toBe(first.sourceFingerprint); expect(changedSource.dependencyFingerprint).toBe(first.dependencyFingerprint);
    await writeFile(path.join(source, "package-lock.json"), '{"syntheticChangedLock":true}\n');
    const changedLock = await inputProvenance(source, ["fixture.ts"], undefined);
    expect(changedLock.dependencyFingerprint).not.toBe(first.dependencyFingerprint); expect(changedLock.fingerprint).not.toBe(changedSource.fingerprint);
    expect(artifactManifest(first, [{ path: "/one/api.js", contents: Buffer.from("test") }], "/one")).toEqual(artifactManifest(first, [{ path: "/two/api.js", contents: Buffer.from("test") }], "/two"));
  });
  it("reports exactly the compiled manifest fingerprint only after successful protected readiness", async () => {
    const provenance = { version: 1, sourceRevision: "a".repeat(40), sourceFingerprint: "b".repeat(64), dependencyFingerprint: "c".repeat(64), fingerprint: "d".repeat(64) };
    const output = await folder(); const outfile = path.join(output, "provenance.mjs");
    await build({ entryPoints: [path.join(root, "services/api-text-worker/build-manifest.ts")], outfile, bundle: true, format: "esm", platform: "node", define: { __EMBEL_API_TEXT_BUILD__: JSON.stringify(provenance) } });
    const built = await import(/* @vite-ignore */ outfile);
    expect(built.workerBuildProvenance()).toEqual(provenance);
    const body = { version: 1, deploymentId: "dpl_synthetic", operations: [] };
    const ready = built.addWorkerBuildProvenance(Response.json(body));
    expect(await ready.json()).toEqual(body); expect(ready.headers.get("x-embel-worker-fingerprint")).toBe(provenance.fingerprint);
    expect(ready.headers.get("x-embel-worker-source-revision")).toBe(provenance.sourceRevision);
    for (const status of [400, 401, 405, 503]) expect(built.addWorkerBuildProvenance(new Response(null, { status })).headers.has("x-embel-worker-fingerprint")).toBe(false);
  });
  it("builds the real four-entrypoint artifact reproducibly with lifecycle support and exact output hashes", async () => {
    const first = await buildApiTextWorker({ output: await folder() });
    const second = await buildApiTextWorker({ output: await folder() });
    expect(first.manifest).toEqual(second.manifest); expect(first.manifest.sourceRevision).toBeNull();
    expect((await readdir(first.output)).sort()).toEqual([".vercelignore", "api", "build-manifest.json", "package.json", "vercel.json"]);
    for (const entry of first.manifest.outputs) {
      const actual = createHash("sha256").update(await readFile(path.join(first.output, entry.path))).digest("hex");
      expect(actual).toBe(entry.sha256);
    }
    const enqueue = await readFile(path.join(first.output, "api/enqueue.js"), "utf8");
    expect(enqueue).toContain("attachDatabasePool");
    const readiness = await readFile(path.join(first.output, "api/readiness.js"), "utf8");
    expect(readiness).toContain(first.manifest.fingerprint);
    expect(first.manifest.outputs.map(output => output.path).filter(file => file.endsWith(".js"))).toEqual(["api/consume.js", "api/cron/repair-api-text.js", "api/enqueue.js", "api/readiness.js"]);
  }, 60_000);
});
