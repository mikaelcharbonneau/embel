import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installSharedRuntimePackages, readSharedRuntimePackages, readSharedRuntimeFilePins } from "./package-runtime.mjs";

export const sharedProductionProjects = Object.freeze(["prj_waP1hoGVtBiqJCTqTWKHfRy8iLMk", "prj_vTOc6Kf8th7tXK2cOVwWTTaR20yx"]);
const fail = () => Error("Shared worker release source unavailable");
const digest = value => createHash("sha256").update(value).digest("hex");

/** Explicit local packaging only. Default native installer verifies the fixed Linux runtime
 * USTAR/package-lock/integrity and source-file pins. No configuration or secret
 * environment values are copied; no deployment API or credential is used. */
export async function prepareSharedWorkerRelease({ root, projectId, mode }, dependencies = {}) {
  if (!sharedProductionProjects.includes(projectId) || !["stopped", "active"].includes(mode)) throw fail();
  const git = dependencies.git ?? ((...args) => {
    const output = execFileSync("git", args, { cwd: root, encoding: "utf8" });
    return args[0] === "show" ? output : output.trim();
  });
  const revision = git("rev-parse", "HEAD");
  if (!/^[a-f0-9]{40}$/u.test(revision) || git("status", "--porcelain", "--untracked-files=normal")
    || mode === "active" && git("branch", "--show-current") !== "main") throw fail();
  const source = path.join(root, "services/shared-worker"), bundles = path.join(root, ".tmp/shared-worker");
  const files = ["build-manifest.json", "index.js", "package.json", "raster.js", "render.js", "text.js"];
  if (!(await lstat(bundles)).isDirectory() || JSON.stringify((await readdir(bundles)).filter(name => name !== "review-source-inputs.json").sort()) !== JSON.stringify(files)) throw fail();
  for (const file of files) if (!(await lstat(path.join(bundles, file))).isFile()) throw fail();
  const manifest = JSON.parse(await readFile(path.join(bundles, "build-manifest.json"), "utf8"));
  const runtimePins = await readSharedRuntimePackages(root), runtimeFiles = await readSharedRuntimeFilePins(root);
  const hashes = { indexSha256: digest(await readFile(path.join(bundles, "index.js"))), rasterSha256: digest(await readFile(path.join(bundles, "raster.js"))), textSha256: digest(await readFile(path.join(bundles, "text.js"))), renderSha256: digest(await readFile(path.join(bundles, "render.js"))), runtimePinsSha256: digest(JSON.stringify({ packages: runtimePins, files: runtimeFiles })) };
  if (manifest.version !== 2 || manifest.sourceRevision !== revision || manifest.sourceClean !== true
    || manifest.indexSha256 !== hashes.indexSha256 || manifest.rasterSha256 !== hashes.rasterSha256 || manifest.textSha256 !== hashes.textSha256 || manifest.renderSha256 !== hashes.renderSha256 || manifest.runtimePinsSha256 !== hashes.runtimePinsSha256
    || manifest.artifactSha256 !== digest(JSON.stringify(hashes))) throw fail();
  const runtimePackage = JSON.parse(await readFile(path.join(bundles, "package.json"), "utf8"));
  if (JSON.stringify(runtimePackage) !== JSON.stringify({ private: true, type: "module", engines: { node: "22.22.2" }, dependencies: Object.fromEntries(runtimePins.map(pin => [pin.name, pin.version])) })) throw fail();
  // Both build inputs and all copied control bytes must be committed source.
  for (const relative of ["services/shared-worker/Containerfile", "services/shared-worker/.dockerignore", "services/shared-worker/vercel.json",
    "worker/shared-pool/source-inputs.json", "worker/shared-pool/authority-manifest.json", "services/logo-worker/runtime-packages.json", "services/shared-worker/runtime-packages.json", "services/shared-worker/runtime-files.json", "services/shared-worker/package-runtime.mjs", "services/logo-worker/package-runtime.mjs", "package-lock.json"]) {
    if (!(await lstat(path.join(root, relative))).isFile()
      || git("show", "HEAD:" + relative) !== (await readFile(path.join(root, relative), "utf8"))) throw fail();
  }
  const configuration = JSON.parse(await readFile(path.join(source, "vercel.json"), "utf8"));
  if (JSON.stringify(Object.keys(configuration.daemons ?? {})) !== JSON.stringify(["shared-worker"])
    || configuration.daemons["shared-worker"].instances.iad1 !== 0) throw fail();
  configuration.daemons["shared-worker"].instances = { iad1: mode === "stopped" ? 0 : 1 };
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const release = await mkdtemp(path.join(root, ".tmp/shared-worker-release-")), worker = path.join(release, "shared-worker");
  await mkdir(path.join(worker, "dist"), { recursive: true });
  for (const file of files) await copyFile(path.join(bundles, file), path.join(worker, "dist", file));
  for (const file of ["Containerfile", ".dockerignore"]) await copyFile(path.join(source, file), path.join(worker, file));
  const runtime = await (dependencies.installRuntime ?? installSharedRuntimePackages)(root, worker);
  await writeFile(path.join(worker, "dist/runtime-manifest.json"), JSON.stringify(runtime, null, 2) + "\n");
  await writeFile(path.join(release, "vercel.json"), JSON.stringify(configuration, null, 2) + "\n");
  await writeFile(path.join(release, "package.json"), JSON.stringify({ name: "embel-shared-worker-release", private: true, type: "module" }) + "\n");
  await mkdir(path.join(release, "static"));
  await writeFile(path.join(release, "static/index.html"), "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Embel</title></head><body></body></html>\n");
  await writeFile(path.join(release, ".vercelignore"), "**\n!vercel.json\n!package.json\n!static\n!static/index.html\n!shared-worker\n!shared-worker/Containerfile\n!shared-worker/.dockerignore\n!shared-worker/dist\n!shared-worker/dist/**\n!shared-worker/node_modules\n!shared-worker/node_modules/**\n");
  return { release, mode, projectId, sourceRevision: revision, artifactSha256: manifest.artifactSha256,
    runtimePackages: runtime.packages.map(({ name, version }) => ({ name, version })) };
}
