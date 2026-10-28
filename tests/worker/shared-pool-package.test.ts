import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareSharedWorkerRelease, sharedProductionProjects } from "../../services/shared-worker/package-release.mjs";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [], controls = ["services/shared-worker/Containerfile", "services/shared-worker/.dockerignore", "services/shared-worker/vercel.json",
 "worker/shared-pool/source-inputs.json", "worker/shared-pool/authority-manifest.json", "services/logo-worker/runtime-packages.json", "services/shared-worker/runtime-packages.json", "services/shared-worker/runtime-files.json", "services/shared-worker/package-runtime.mjs", "services/logo-worker/package-runtime.mjs", "package-lock.json"];
/** Explicit inert source-proof and native-installer ports. This tests package
 * boundaries, not a clean release of the real uncommitted worktree. */
async function fixture() {
 const root = await mkdtemp(path.join(tmpdir(), "embel-shared-release-fixture-")); roots.push(root);
 const committed = new Map<string, string>();
 for (const relative of controls) { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await cp(relative, path.join(root, relative)); committed.set(relative, await readFile(relative, "utf8")); }
 const bundles = path.join(root, ".tmp/shared-worker"); await mkdir(bundles, { recursive: true });
 const runtimePins = JSON.parse(await readFile("services/shared-worker/runtime-packages.json", "utf8")), runtimeFiles = JSON.parse(await readFile("services/shared-worker/runtime-files.json", "utf8")).files;
 const hashes = { indexSha256: digest("inert fixture index"), rasterSha256: digest("inert fixture raster"), textSha256: digest("inert fixture text"), renderSha256: digest("inert fixture render"), runtimePinsSha256: digest(JSON.stringify({packages:runtimePins,files:runtimeFiles})) };
 await writeFile(path.join(bundles, "index.js"), "inert fixture index"); await writeFile(path.join(bundles, "raster.js"), "inert fixture raster");
 await writeFile(path.join(bundles, "text.js"), "inert fixture text"); await writeFile(path.join(bundles, "render.js"), "inert fixture render");
 await writeFile(path.join(bundles, "build-manifest.json"), JSON.stringify({ version: 2, sourceRevision: "a".repeat(40), sourceClean: true, ...hashes, artifactSha256: digest(JSON.stringify(hashes)) }));
 await writeFile(path.join(bundles, "package.json"), JSON.stringify({ private: true, type: "module", engines: { node: "22.22.2" }, dependencies: Object.fromEntries(runtimePins.map((pin:{name:string;version:string})=>[pin.name,pin.version])) }));
 const git = vi.fn((...args: string[]) => args[0] === "show" ? committed.get(args[1]!.slice(5))! : args[0] === "rev-parse" ? "a".repeat(40) : args[0] === "branch" ? "main" : "");
 const installRuntime = vi.fn(async (_root: string, destination: string) => { await mkdir(path.join(destination, "node_modules"), { recursive: true }); return { packages: [{ name: "sharp", version: "0.35.5" }], files: {} }; });
 return { root, bundles, git, installRuntime };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe("production release package boundaries (hermetic native installer)", () => {
 it.each(["stopped", "active"])("packages only explicit bundles and reviewed templates in %s mode", async mode => {
  const f = await fixture(); await writeFile(path.join(f.root, ".env"), "DO_NOT_PACKAGE_SYNTHETIC_SECRET");
  const result = await prepareSharedWorkerRelease({ root: f.root, projectId: sharedProductionProjects[0]!, mode }, f);
  const config = JSON.parse(await readFile(path.join(result.release, "vercel.json"), "utf8"));
  expect(config.daemons["shared-worker"].instances).toEqual({ iad1: mode === "stopped" ? 0 : 1 });
  expect(Object.keys(config.daemons)).toEqual(["shared-worker"]);
  expect(await readdir(path.join(result.release, "shared-worker/dist"))).toEqual(expect.arrayContaining(["build-manifest.json", "index.js", "package.json", "raster.js", "runtime-manifest.json"]));
  expect(await readdir(result.release)).not.toContain(".env");
  expect(f.installRuntime).toHaveBeenCalledOnce();
  expect(await readFile(path.join(result.release, "shared-worker/Containerfile"), "utf8")).toContain("FROM node:22.22.2-bookworm-slim");
  expect(result.sourceRevision).toBe("a".repeat(40));
 });
 it("refuses dirty source or an unrelated project before native installation or package writes", async () => {
  const f = await fixture(), dirtyGit = (...args: string[]) => args[0] === "status" ? " M source.ts" : f.git(...args);
  await expect(prepareSharedWorkerRelease({ root: f.root, projectId: sharedProductionProjects[0]!, mode: "stopped" }, { ...f, git: dirtyGit })).rejects.toThrow("source");
  await expect(prepareSharedWorkerRelease({ root: f.root, projectId: "prj_unapproved", mode: "stopped" }, f)).rejects.toThrow("source");
  expect(f.installRuntime).not.toHaveBeenCalled();
  expect(await readdir(path.join(f.root, ".tmp"))).toEqual(["shared-worker"]);
 });
 it.each(["bundle", "extra", "template", "symlink", "nativepin", "text", "render", "sharedpin", "filepin"])("rejects %s mutation before native installation", async kind => {
  const f = await fixture();
  if (kind === "bundle") await writeFile(path.join(f.bundles, "index.js"), "mutated");
  if (kind === "extra") await writeFile(path.join(f.bundles, ".env"), "SYNTHETIC_SECRET");
  if (kind === "template") await writeFile(path.join(f.root, controls[0]!), "FROM unreviewed");
  if (kind === "symlink") { await rm(path.join(f.bundles, "index.js")); await symlink(path.join(f.bundles, "raster.js"), path.join(f.bundles, "index.js")); expect((await lstat(path.join(f.bundles, "index.js"))).isSymbolicLink()).toBe(true); }
  if (kind === "text" || kind === "render") await writeFile(path.join(f.bundles,kind+".js"),"mutated");
  if (kind === "sharedpin") await writeFile(path.join(f.root,"services/shared-worker/runtime-packages.json"),"[]");
  if (kind === "filepin") await writeFile(path.join(f.root,"services/shared-worker/runtime-files.json"),"{}");
  if (kind === "nativepin") await writeFile(path.join(f.root, "services/logo-worker/runtime-packages.json"), "[]");
  await expect(prepareSharedWorkerRelease({ root: f.root, projectId: sharedProductionProjects[0]!, mode: "stopped" }, f)).rejects.toThrow();
  expect(f.installRuntime).not.toHaveBeenCalled();
 });
 it("requires main for running instances while stopped packaging remains available on a clean feature revision", async () => {
  const f = await fixture(), git = (...args: string[]) => args[0] === "branch" ? "feature/fixture" : f.git(...args);
  await expect(prepareSharedWorkerRelease({ root: f.root, projectId: sharedProductionProjects[0]!, mode: "active" }, { ...f, git })).rejects.toThrow("source");
  expect(f.installRuntime).not.toHaveBeenCalled();
 });
});
