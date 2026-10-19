import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const arguments_ = process.argv.slice(2), container = arguments_.length === 1 && arguments_[0] === "--container";
if (arguments_.length && !container) throw new Error("The Naming worker build accepts only --container.");
let sourceRevision, sourceClean;
const expectedProjectId = process.env.EMBEL_NAMING_VERCEL_PROJECT_ID ?? "";
if (expectedProjectId && (!/^prj_[A-Za-z0-9]{10,100}$/u.test(expectedProjectId) || expectedProjectId === "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt"))
  throw new Error("Naming worker project identity invalid.");
if (container) {
  // Vercel supplies public deployment metadata as Docker build arguments.
  // The image context deliberately excludes Git metadata and credentials.
  const gitMetadata = await lstat(path.join(root, ".git")).catch(error => {
    if (error.code === "ENOENT") return null;
    throw new Error("Naming worker container source could not be inspected.");
  });
  if (gitMetadata) throw new Error("Naming worker container context must exclude Git metadata.");
  if (!expectedProjectId || process.env.VERCEL_PROJECT_ID !== expectedProjectId
    || process.env.VERCEL_ENV !== "production" || process.env.VERCEL_TARGET_ENV !== "production")
    throw new Error("Naming worker container deployment unqualified.");
  sourceRevision = process.env.VERCEL_GIT_COMMIT_SHA ?? "";
  // The container has no checkout from which to claim a clean working tree.
  sourceClean = null;
} else {
  sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  sourceClean = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trim() === "";
  if (process.env.VERCEL === "1" && !sourceClean) throw new Error("Naming worker production build requires clean source.");
}
if (!/^[a-f0-9]{40}$/u.test(sourceRevision)) throw new Error("Naming worker source revision unavailable.");
if (process.env.VERCEL_GIT_COMMIT_SHA !== undefined && process.env.VERCEL_GIT_COMMIT_SHA !== sourceRevision)
  throw new Error("Naming worker source revision mismatch.");
const output = path.join(root, "services/naming-worker/dist");
const result = await build({ absWorkingDir: root, entryPoints: [path.join(root, "services/naming-worker/index.ts")], outfile: path.join(output, "index.js"),
  bundle: true, platform: "node", format: "esm", target: "node22.22", conditions: ["react-server"],
  external: ["pg-native"], sourcemap: false, metafile: true, legalComments: "none", write: false,
  define: { __EMBEL_NAMING_BUILD_REVISION__: JSON.stringify(sourceRevision), __EMBEL_NAMING_BUILD_PROJECT_ID__: JSON.stringify(expectedProjectId) },
  banner: { js: 'import { createRequire as __embelCreateRequire } from "node:module"; const require = __embelCreateRequire(import.meta.url);' },
});
// Only the dedicated Naming graph is deployable. No checkout, local launcher,
// secrets, web runtime, Strategy handlers or other worker entrypoint is copied.
const inputs = Object.keys(result.metafile.inputs).sort();
for (const source of inputs) {
  if (/(^|\/)(\.env[^/]*|\.local-fluid|\.vercel|\.secrets|\.credentials)(\/|$)/u.test(source)
    || /(?:^|\/)(?:scripts\/local-[^/]*|worker\/index\.ts|worker\/handlers\/openai-strategy\.ts|src\/app\/)/u.test(source))
    throw new Error("Protected or unrelated Naming build input rejected.");
}
// Changes to the first-party import graph require an explicit reviewed update.
// Package contents remain pinned by package-lock.json and npm ci.
let expectedSourceInputs;
try { expectedSourceInputs = JSON.parse(await readFile(path.join(root, "services/naming-worker/source-inputs.json"), "utf8")); }
catch { throw new Error("Naming worker source allowlist unavailable."); }
const dependencyDirectory = await realpath(path.join(root, "node_modules"));
const sourceInputs = inputs.filter(source => {
  const relative = path.relative(dependencyDirectory, path.resolve(root, source));
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
});
if (!Array.isArray(expectedSourceInputs) || expectedSourceInputs.some(source => typeof source !== "string")
  || JSON.stringify(sourceInputs) !== JSON.stringify(expectedSourceInputs))
  throw new Error("Naming worker source graph differs from its reviewed allowlist.");
const bundle = result.outputFiles.find(file => file.path === path.join(output, "index.js"));
if (!bundle || result.outputFiles.length !== 1) throw new Error("Unexpected Naming worker output.");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "index.js"), bundle.contents);
await writeFile(path.join(output, "package.json"), JSON.stringify({ name: "embel-naming-worker", version: "0.1.0", private: true, type: "module", engines: { node: "22.22.2" } }, null, 2) + "\n");
await writeFile(path.join(output, "build-manifest.json"), JSON.stringify({ sourceRevision, sourceClean,
  sourceOrigin: container ? "vercel_git_metadata" : "git_checkout", projectId: expectedProjectId || null,
  bundleSha256: createHash("sha256").update(bundle.contents).digest("hex"), inputs }, null, 2) + "\n");
console.log("Naming-only worker bundle ready: services/naming-worker/dist/index.js");
