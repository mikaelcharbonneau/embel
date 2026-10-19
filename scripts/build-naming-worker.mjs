import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv.length !== 2) throw new Error("The Naming worker build accepts no arguments.");
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/u.test(sourceRevision)) throw new Error("Naming worker source revision unavailable.");
if (process.env.RENDER_GIT_COMMIT !== undefined && process.env.RENDER_GIT_COMMIT !== sourceRevision)
  throw new Error("Naming worker source revision mismatch.");
const sourceClean = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trim() === "";
if (process.env.RENDER === "true" && !sourceClean) throw new Error("Naming worker production build requires clean source.");
const output = path.join(root, "services/naming-worker/dist");
const result = await build({ entryPoints: [path.join(root, "services/naming-worker/index.ts")], outfile: path.join(output, "index.js"),
  bundle: true, platform: "node", format: "esm", target: "node22.22", conditions: ["react-server"],
  external: ["pg-native"], sourcemap: false, metafile: true, legalComments: "none", write: false,
  define: { __EMBEL_NAMING_BUILD_REVISION__: JSON.stringify(sourceRevision) },
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
const bundle = result.outputFiles.find(file => file.path === path.join(output, "index.js"));
if (!bundle || result.outputFiles.length !== 1) throw new Error("Unexpected Naming worker output.");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "index.js"), bundle.contents);
await writeFile(path.join(output, "package.json"), JSON.stringify({ name: "embel-naming-worker", version: "0.1.0", private: true, type: "module", engines: { node: "22.22.2" } }, null, 2) + "\n");
await writeFile(path.join(output, "build-manifest.json"), JSON.stringify({ sourceRevision, sourceClean,
  bundleSha256: createHash("sha256").update(bundle.contents).digest("hex"), inputs }, null, 2) + "\n");
console.log("Naming-only worker bundle ready: services/naming-worker/dist/index.js");
