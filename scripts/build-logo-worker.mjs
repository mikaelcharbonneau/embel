import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.length !== 2) throw new Error("The Logo worker build accepts no arguments.");
const projectId = "prj_QSWj13AkZzw4t8ZOGVzncFczz2gC";
if (process.env.EMBEL_LOGO_VERCEL_PROJECT_ID !== undefined && process.env.EMBEL_LOGO_VERCEL_PROJECT_ID !== projectId)
  throw new Error("Logo worker project identity invalid.");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sourceRevision = git("rev-parse", "HEAD"), sourceClean = git("status", "--porcelain", "--untracked-files=normal") === "";
if (!/^[a-f0-9]{40}$/u.test(sourceRevision) || process.env.VERCEL_GIT_COMMIT_SHA !== undefined && process.env.VERCEL_GIT_COMMIT_SHA !== sourceRevision)
  throw new Error("Logo worker source revision mismatch.");
if (process.env.VERCEL === "1") throw new Error("Logo bundles must be prepared outside the secret-bearing Vercel build.");
const output = path.join(root, "services/logo-worker/dist"), dependencyDirectory = await realpath(path.join(root, "node_modules"));
let allowlist;
try { allowlist = JSON.parse(await readFile(path.join(root, "services/logo-worker/source-inputs.json"), "utf8")); }
catch { throw new Error("Logo worker source allowlist unavailable."); }
const bundles = {}, inputs = {};
for (const [name, source, child] of [["index", "services/logo-worker/index.ts", false], ["raster", "worker/logo-vector/process.ts", true], ["raster-check", "services/logo-worker/raster-check.ts", false]]) {
  const target = path.join(output, `${name}.js`);
  const result = await build({ absWorkingDir: root, entryPoints: [path.join(root, source)], outfile: target,
    bundle: true, platform: "node", format: "esm", target: "node22.22", conditions: ["react-server"],
    external: ["pg-native", "sharp"], sourcemap: false, metafile: true, legalComments: "none", write: false,
    define: { __EMBEL_LOGO_BUILD_REVISION__: JSON.stringify(sourceRevision), __EMBEL_LOGO_BUILD_PROJECT_ID__: JSON.stringify(projectId),
      __EMBEL_LOGO_RASTER_ENTRYPOINT__: JSON.stringify("dist/raster.js"), __EMBEL_LOGO_RASTER_CHILD__: JSON.stringify(child) },
    banner: { js: 'import { createRequire as __embelCreateRequire } from "node:module"; const require = __embelCreateRequire(import.meta.url);' },
  });
  const graph = Object.keys(result.metafile.inputs).sort();
  if (graph.some(source => /(^|\/)(\.env[^/]*|\.local-fluid|\.vercel|\.secrets|\.credentials)(\/|$)/u.test(source)
    || /^(?:src\/app\/|scripts\/|services\/(?:naming|api-text)-worker\/|worker\/index\.ts)/u.test(source)))
    throw new Error("Protected or unrelated Logo build input rejected.");
  const firstParty = graph.filter(source => {
    const relative = path.relative(dependencyDirectory, path.resolve(root, source));
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  });
  if (!Array.isArray(allowlist[name]) || JSON.stringify(firstParty) !== JSON.stringify(allowlist[name]))
    throw new Error(`Logo ${name} source graph differs from its reviewed allowlist.`);
  const bundle = result.outputFiles.find(file => file.path === target);
  if (!bundle || result.outputFiles.length !== 1) throw new Error("Unexpected Logo worker output.");
  bundles[`${name}.js`] = bundle.contents; inputs[name] = graph;
}
await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
const hashes = {};
for (const [name, bytes] of Object.entries(bundles)) { await writeFile(path.join(output, name), bytes); hashes[name] = createHash("sha256").update(bytes).digest("hex"); }
await writeFile(path.join(output, "package.json"), JSON.stringify({ name: "embel-logo-worker", version: "0.1.0", private: true, type: "module", engines: { node: "22.22.2" } }, null, 2) + "\n");
await writeFile(path.join(output, "build-manifest.json"), JSON.stringify({ sourceRevision, sourceClean, sourceOrigin: "git_checkout", projectId,
  bundleSha256: hashes, runtime: { node: "22.22.2", platform: "linux", arch: "x64", libc: "glibc", sharp: "0.35.5" }, inputs }, null, 2) + "\n");
console.log("Logo worker and isolated raster bundles ready: services/logo-worker/dist");
