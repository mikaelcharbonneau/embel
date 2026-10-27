export const sharedProductionProjects: readonly string[];
export type SharedReleaseDependencies = {
 git?: (...args: string[]) => string;
 installRuntime?: (root: string, destination: string) => Promise<{ packages: { name: string; version: string }[]; files?: Record<string, string> }>;
};
export function prepareSharedWorkerRelease(options: { root: string; projectId: string; mode: string }, dependencies?: SharedReleaseDependencies): Promise<{
 release: string; mode: string; projectId: string; sourceRevision: string; artifactSha256: string;
 runtimePackages: { name: string; version: string }[];
}>;
