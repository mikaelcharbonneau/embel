import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const arguments_ = process.argv.slice(2);
if (arguments_.length !== 4 || arguments_[0] !== "--project" || arguments_[2] !== "--mode"
  || !/^prj_[A-Za-z0-9]{10,100}$/u.test(arguments_[1]) || arguments_[1] === "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt"
  || !["stopped", "standby", "active"].includes(arguments_[3]))
  throw new Error("Use --project <dedicated-worker-project-id> --mode stopped|standby|active.");
const projectId = arguments_[1], mode = arguments_[3];
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const revision = git("rev-parse", "HEAD");
if (!/^[a-f0-9]{40}$/u.test(revision) || git("status", "--porcelain", "--untracked-files=normal")
  || mode !== "stopped" && git("branch", "--show-current") !== "main")
  throw new Error("Cloud releases require clean source; running instances require main.");

const source = path.join(root, "services/naming-worker"), bundleDirectory = path.join(source, "dist");
const files = ["build-manifest.json", "index.js", "package.json"];
if (JSON.stringify((await readdir(bundleDirectory)).sort()) !== JSON.stringify(files))
  throw new Error("Unexpected Naming bundle file.");
for (const file of files) if (!(await lstat(path.join(bundleDirectory, file))).isFile())
  throw new Error("Naming bundle must contain ordinary files.");
const manifest = JSON.parse(await readFile(path.join(bundleDirectory, "build-manifest.json"), "utf8"));
if (manifest.sourceRevision !== revision || manifest.sourceClean !== true || manifest.sourceOrigin !== "git_checkout"
  || manifest.projectId !== projectId
  || manifest.bundleSha256 !== createHash("sha256").update(await readFile(path.join(bundleDirectory, "index.js"))).digest("hex"))
  throw new Error("Naming bundle does not match this clean source and dedicated project.");

await mkdir(path.join(root, ".tmp"), { recursive: true });
const release = await mkdtemp(path.join(root, ".tmp", "naming-worker-"));
const worker = path.join(release, "naming-worker");
await mkdir(path.join(worker, "dist"), { recursive: true });
for (const file of files) await copyFile(path.join(bundleDirectory, file), path.join(worker, "dist", file));
for (const file of ["Containerfile", ".dockerignore"]) await copyFile(path.join(source, file), path.join(worker, file));
const configuration = JSON.parse(await readFile(path.join(source, "vercel.json"), "utf8"));
configuration.daemons["naming-worker"].instances = { iad1: mode === "stopped" ? 0 : 1 };
if (mode === "standby") configuration.daemons["naming-worker"].command = ["node", "dist/index.js", "--standby"];
await writeFile(path.join(release, "vercel.json"), JSON.stringify(configuration, null, 2) + "\n");
await writeFile(path.join(release, "package.json"), JSON.stringify({ name: "embel-naming-worker-release", private: true, type: "module" }) + "\n");
await mkdir(path.join(release, "static"));
await writeFile(path.join(release, "static", "index.html"), "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Embel</title></head><body></body></html>\n");
await writeFile(path.join(release, ".vercelignore"), "**\n!vercel.json\n!package.json\n!static/\n!static/index.html\n!naming-worker/\n!naming-worker/Containerfile\n!naming-worker/.dockerignore\n!naming-worker/dist/\n!naming-worker/dist/index.js\n!naming-worker/dist/package.json\n!naming-worker/dist/build-manifest.json\n");
// Only public provenance is printed. This script neither loads nor transfers
// credentials and never creates a deployment or enables the database pilot.
console.log(JSON.stringify({ release, mode, projectId, sourceRevision: revision, bundleSha256: manifest.bundleSha256 }));
