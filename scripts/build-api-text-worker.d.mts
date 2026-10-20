import type { BuildManifest } from "./lib/api-text-build-manifest.mjs";
export function buildApiTextWorker(options?: { root?: string; output?: string; sourceRevision?: string | null }): Promise<{ output: string; manifest: BuildManifest }>;
