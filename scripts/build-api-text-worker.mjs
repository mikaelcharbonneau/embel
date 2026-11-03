import { build } from "./esbuild-project.mjs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { artifactManifest, checkedInputPath, inputProvenance, validatedSourceRevision } from "./lib/api-text-build-manifest.mjs";

export async function buildApiTextWorker({ root = fileURLToPath(new URL("../", import.meta.url)), output, sourceRevision } = {}) {
  validatedSourceRevision(sourceRevision);
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  output ??= await mkdtemp(path.join(root, ".tmp", "api-text-worker-"));
  const entryPoints = ["enqueue", "readiness", "consume", "cron/repair-api-text"].map(name => path.join(root, "services/api-text-worker/api", `${name}.ts`));
  const options = { absWorkingDir: root, entryPoints, outbase: path.join(root, "services/api-text-worker"), outdir: output,
    bundle: true, platform: "node", format: "esm", target: "node24", conditions: ["react-server"], loader: { ".crt": "text" },
    external: ["pg-native"], sourcemap: false, metafile: true, legalComments: "none", write: false,
    banner: { js: 'import { createRequire as __fluidCreateRequire } from "node:module"; const require = __fluidCreateRequire(import.meta.url);' },
  };
  // Discover the exact dependency graph without copying source or environment files.
  const graph = await build(options);
  const provenance = await inputProvenance(root, Object.keys(graph.metafile.inputs), sourceRevision);
  const result = await build({ ...options, define: { __EMBEL_API_TEXT_BUILD__: JSON.stringify(provenance) } });
  // esbuild represents the literal define as a virtual input, not a file.
  const finalSources = Object.keys(result.metafile.inputs).filter(source => source !== "<define:__EMBEL_API_TEXT_BUILD__>");
  for (const source of finalSources) checkedInputPath(root, source);
  // Recheck inputs before publishing output: a concurrent edit must not produce a
  // manifest describing one source graph and an artifact from a different graph.
  const verified = await inputProvenance(root, finalSources, sourceRevision);
  if (verified.fingerprint !== provenance.fingerprint) throw new Error("Worker build inputs changed during compilation");
  const configuration = await readFile(path.join(root, "services/api-text-worker/vercel.json"));
  const config = JSON.parse(configuration.toString("utf8"));
  if (config.functions["api/consume.js"].experimentalTriggers[0].type !== "queue/v2beta") throw new Error("Private consumer trigger missing");
  const packageFile = JSON.stringify({ name: "fluid-api-text-worker", version: "0.1.0", private: true, type: "module", engines: { node: "24.x" } }, null, 2) + "\n";
  const files = [...result.outputFiles,
    { path: path.join(output, "vercel.json"), contents: configuration },
    { path: path.join(output, "package.json"), contents: Buffer.from(packageFile) },
    { path: path.join(output, ".vercelignore"), contents: Buffer.from("/*\n!/api\n!/api/**\n!/package.json\n!/vercel.json\n!/build-manifest.json\n") }];
  const manifest = artifactManifest(provenance, files, output);
  for (const file of files) { await mkdir(path.dirname(file.path), { recursive: true }); await writeFile(file.path, file.contents); }
  // Hashes cover every deployable output except this manifest itself (no circular hash).
  await writeFile(path.join(output, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { output, manifest };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !/^--source-revision=[0-9a-f]{40}$/.test(arg)) || args.length > 1) throw new Error("Usage: build-api-text-worker.mjs [--source-revision=<reviewed Git SHA>]");
  const { output } = await buildApiTextWorker({ sourceRevision: args[0]?.split("=")[1] });
  console.log(`Worker-only bundle ready: ${output}`);
}
