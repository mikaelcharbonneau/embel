export type SharedRuntimePackage = { name: string; version: string; resolved: string; integrity: string };
export type SharedRuntimeManifest = { version: 1; platform: "linux"; arch: "x64"; libc: "glibc"; packages: SharedRuntimePackage[]; files: Record<string, string> };
export function readSharedRuntimePackages(root: string): Promise<SharedRuntimePackage[]>;
export function readSharedRuntimeFilePins(root: string): Promise<Record<string, string>>;
export function installSharedRuntimePackages(root: string, destination: string, dependencies?: { download?: (pin: SharedRuntimePackage) => Promise<Uint8Array> }): Promise<SharedRuntimeManifest>;
