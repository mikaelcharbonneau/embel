import { afterEach, beforeEach } from "vitest";

/** Shared-pool and account artifacts are qualified only for linux/x64 (CI and
 * the hosted runtime). Tests of the attestation logic present that runtime so
 * they behave the same on a macOS or arm64 developer machine. */
export function simulateQualifiedLinuxRuntime() {
  const original = { platform: Object.getOwnPropertyDescriptor(process, "platform")!, arch: Object.getOwnPropertyDescriptor(process, "arch")! };
  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...original.platform, value: "linux" });
    Object.defineProperty(process, "arch", { ...original.arch, value: "x64" });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", original.platform);
    Object.defineProperty(process, "arch", original.arch);
  });
}
