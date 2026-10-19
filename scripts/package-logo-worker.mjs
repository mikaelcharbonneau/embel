import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installLogoRuntimePackages } from "../services/logo-worker/package-runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), arguments_ = process.argv.slice(2);
const projectId = "prj_QSWj13AkZzw4t8ZOGVzncFczz2gC";
if (arguments_.length !== 4 || arguments_[0] !== "--project" || arguments_[1] !== projectId || arguments_[2] !== "--mode"
  || !["stopped", "standby", "active"].includes(arguments_[3]))
  throw new Error("Use --project <dedicated-logo-project-id> --mode stopped|standby|active.");
const mode = arguments_[3], git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const revision = git("rev-parse", "HEAD");
if (!/^[a-f0-9]{40}$/u.test(revision) || git("status", "--porcelain", "--untracked-files=normal")
  || mode !== "stopped" && git("branch", "--show-current") !== "main")
  throw new Error("Cloud releases require clean source; running instances require main.");
const source = path.join(root, "services/logo-worker"), bundleDirectory = path.join(source, "dist");
const files = ["build-manifest.json", "index.js", "package.json", "raster-check.js", "raster.js"];
if (!(await lstat(bundleDirectory)).isDirectory() || JSON.stringify((await readdir(bundleDirectory)).sort()) !== JSON.stringify(files))
  throw new Error("Unexpected Logo bundle file.");
for (const file of files) if (!(await lstat(path.join(bundleDirectory, file))).isFile()) throw new Error("Logo bundle must contain ordinary files.");
const manifest = JSON.parse(await readFile(path.join(bundleDirectory, "build-manifest.json"), "utf8"));
if (manifest.sourceRevision !== revision || manifest.sourceClean !== true || manifest.sourceOrigin !== "git_checkout" || manifest.projectId !== projectId
  || JSON.stringify(Object.keys(manifest.bundleSha256 ?? {}).sort()) !== JSON.stringify(["index.js", "raster-check.js", "raster.js"]))
  throw new Error("Logo bundle does not match this clean source and dedicated project.");
for (const file of ["index.js", "raster.js", "raster-check.js"]) if (manifest.bundleSha256[file] !== createHash("sha256").update(await readFile(path.join(bundleDirectory, file))).digest("hex"))
  throw new Error("Logo bundle digest does not match its manifest.");
// Validate every copied control file against Git. Neither an ignored payload
// nor a modified template can enter the isolated release.
for (const file of ["Containerfile", ".dockerignore", "vercel.json"]) {
  const filename = path.join(source, file);
  if (!(await lstat(filename)).isFile() || !Buffer.from(execFileSync("git", ["show", `HEAD:services/logo-worker/${file}`], { cwd: root })).equals(await readFile(filename)))
    throw new Error("Logo release template differs from source.");
}
await mkdir(path.join(root, ".tmp"), { recursive: true });
const release = await mkdtemp(path.join(root, ".tmp", "logo-worker-")), worker = path.join(release, "logo-worker");
await mkdir(path.join(worker, "dist"), { recursive: true });
for (const file of files) await copyFile(path.join(bundleDirectory, file), path.join(worker, "dist", file));
for (const file of ["Containerfile", ".dockerignore"]) await copyFile(path.join(source, file), path.join(worker, file));
const runtime = await installLogoRuntimePackages(root, worker);
await writeFile(path.join(worker, "dist/runtime-manifest.json"), JSON.stringify(runtime, null, 2) + "\n");
const configuration = JSON.parse(await readFile(path.join(source, "vercel.json"), "utf8"));
configuration.daemons["logo-worker"].instances = { iad1: mode === "stopped" ? 0 : 1 };
if (mode === "standby") configuration.daemons["logo-worker"].command = ["node", "dist/index.js", "--standby"];
await writeFile(path.join(release, "vercel.json"), JSON.stringify(configuration, null, 2) + "\n");
await writeFile(path.join(release, "package.json"), JSON.stringify({ name: "embel-logo-worker-release", private: true, type: "module" }) + "\n");
await mkdir(path.join(release, "static"));
await writeFile(path.join(release, "static/index.html"), "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Embel</title></head><body></body></html>\n");
await writeFile(path.join(release, ".vercelignore"), "**\n!vercel.json\n!package.json\n!static\n!static/index.html\n!logo-worker\n!logo-worker/Containerfile\n!logo-worker/.dockerignore\n!logo-worker/dist\n!logo-worker/dist/**\n!logo-worker/node_modules\n!logo-worker/node_modules/**\n");
// Public provenance only. No credential loading, transfer or deployment.
console.log(JSON.stringify({ release, mode, projectId, sourceRevision: revision, bundleSha256: manifest.bundleSha256, runtimePackages: runtime.packages.map(({ name, version }) => ({ name, version })) }));
