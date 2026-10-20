export type BuildProvenance = { version: 1; sourceRevision: string | null; sourceFingerprint: string; dependencyFingerprint: string; fingerprint: string };
export type BuildManifest = BuildProvenance & { outputs: Array<{ path: string; sha256: string }> };
export function sha256(value: string | Uint8Array): string;
export function validatedSourceRevision(value: unknown): string | null;
export function checkedInputPath(root: string, source: string): { absolute: string; relative: string };
export function inputProvenance(root: string, sources: string[], sourceRevision?: string | null): Promise<BuildProvenance>;
export function artifactManifest(provenance: BuildProvenance, files: Array<{ path: string; contents: Uint8Array }>, output: string): BuildManifest;
