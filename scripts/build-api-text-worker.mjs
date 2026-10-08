import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, ".tmp"), { recursive: true });
const output = await mkdtemp(path.join(root, ".tmp", "api-text-worker-"));
const entryPoints = ["enqueue", "consume", "cron/repair-api-text"].map(name => path.join(root, "services/api-text-worker/api", `${name}.ts`));
const result = await build({ entryPoints, outbase: path.join(root, "services/api-text-worker"), outdir: output,
  bundle: true, platform: "node", format: "esm", target: "node24", conditions: ["react-server"], loader: { ".crt": "text" },
  external: ["pg-native"], sourcemap: false, metafile: true, legalComments: "none",
  banner: { js: 'import { createRequire as __fluidCreateRequire } from "node:module"; const require = __fluidCreateRequire(import.meta.url);' },
});
// Bundle only the three entrypoint dependency graphs. Never copy the checkout,
// environment, credentials, caches, source maps, or the web project's config.
for (const source of Object.keys(result.metafile.inputs)) {
  if (/(^|\/)(\.env[^/]*|\.local-fluid|\.vercel)(\/|$)/.test(source)) throw new Error("Protected build input rejected");
}
await copyFile(path.join(root, "services/api-text-worker/vercel.json"), path.join(output, "vercel.json"));
await writeFile(path.join(output, "package.json"), JSON.stringify({ name: "fluid-api-text-worker", version: "0.1.0", private: true, type: "module", engines: { node: "24.x" } }, null, 2) + "\n");
await writeFile(path.join(output, ".vercelignore"), "/*\n!/api\n!/api/**\n!/package.json\n!/vercel.json\n");
const config = JSON.parse(await readFile(path.join(output, "vercel.json"), "utf8"));
if (config.functions["api/consume.js"].experimentalTriggers[0].type !== "queue/v2beta") throw new Error("Private consumer trigger missing");
console.log(`Worker-only bundle ready: ${output}`);
