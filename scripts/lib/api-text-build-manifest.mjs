import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const sha256 = value => createHash("sha256").update(value).digest("hex");
export function validatedSourceRevision(value) {
  if (value === undefined || value === null) return null;
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("Build source revision must be a full reviewed Git SHA");
  return value;
}
export function checkedInputPath(root, source) {
  const absolute = path.resolve(root, source.replace(/\?raw$/, ""));
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative) ||
      /(^|\/)(\.env[^/]*|\.local-fluid|\.vercel|\.git|\.aws|credentials)(\/|$)/.test(relative)) throw new Error("Protected build input rejected");
  return { absolute, relative };
}
export async function inputProvenance(root, sources, sourceRevision) {
  const inputs = [...new Set([...sources, "scripts/build-api-text-worker.mjs", "scripts/lib/api-text-build-manifest.mjs", "services/api-text-worker/vercel.json", "package.json", "package-lock.json"])]
    .map(source => checkedInputPath(root, source)).sort((a, b) => a.relative.localeCompare(b.relative, "en"));
  const entries = await Promise.all(inputs.map(async input => [input.relative, sha256(await readFile(input.absolute))]));
  const sourceFingerprint = sha256(JSON.stringify(entries));
  const dependencyFingerprint = sha256(JSON.stringify(entries.filter(([name]) => name === "package.json" || name === "package-lock.json")));
  const facts = { version: 1, sourceRevision: validatedSourceRevision(sourceRevision), sourceFingerprint, dependencyFingerprint };
  return { ...facts, fingerprint: sha256(JSON.stringify(facts)) };
}
export function artifactManifest(provenance, files, output) {
  const outputs = files.map(file => ({ path: path.relative(output, file.path).split(path.sep).join("/"), sha256: sha256(file.contents) }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { ...provenance, outputs };
}
