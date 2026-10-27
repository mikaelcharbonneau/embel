import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readLogoRuntimeArchive, readLogoRuntimePackages } from "../logo-worker/package-runtime.mjs";

const names = ["sharp", "@img/colour", "detect-libc", "semver", "@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64", "@napi-rs/canvas", "@napi-rs/canvas-linux-x64-gnu", "@noble/ciphers", "@noble/hashes", "@resvg/resvg-js", "@resvg/resvg-js-linux-x64-gnu", "@swc/helpers", "@visioncortex/vtracer", "base64-js", "brotli", "clone", "dfa", "fast-deep-equal", "fflate", "fontkit", "geist", "harfbuzzjs", "linebreak", "pako", "pdfjs-dist", "pdfkit", "png-js", "restructure", "tiny-inflate", "tslib", "unicode-properties", "unicode-trie"];
const fail = () => new Error("Shared Linux runtime package verification failed.");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export async function readSharedRuntimePackages(root) {
  const filename = path.join(root, "services/shared-worker/runtime-packages.json");
  if (!(await lstat(filename)).isFile()) throw fail();
  const pins = JSON.parse(await readFile(filename, "utf8"));
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const logo = await readLogoRuntimePackages(root);
  if (!Array.isArray(pins) || JSON.stringify(pins.map(pin => pin.name)) !== JSON.stringify(names)
    || JSON.stringify(pins.slice(0, logo.length)) !== JSON.stringify(logo)) throw fail();
  for (const pin of pins) {
    const locked = lock.packages[`node_modules/${pin.name}`];
    if (!locked || JSON.stringify(pin) !== JSON.stringify({ name: pin.name, version: locked.version, resolved: locked.resolved, integrity: locked.integrity })
      || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(pin.integrity)
      || !/^https:\/\/registry\.npmjs\.org\/[A-Za-z0-9@/._-]+\.tgz$/u.test(pin.resolved)
      || Object.keys(locked.dependencies ?? {}).some(name => !names.includes(name))) throw fail();
  }
  return pins;
}

export async function readSharedRuntimeFilePins(root) {
  const filename = path.join(root, "services/shared-worker/runtime-files.json");
  if (!(await lstat(filename)).isFile()) throw fail();
  const value = JSON.parse(await readFile(filename, "utf8"));
  if (value?.version !== 1 || !value.files || Object.keys(value).sort().join() !== "files,version"
    || Object.keys(value.files).length !== 2023 || Object.entries(value.files).some(([name, hash]) =>
      !name.startsWith("node_modules/") || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..")
      || !/^[a-f0-9]{64}$/u.test(hash))) throw fail();
  return value.files;
}

async function download(pin) {
  const response = await fetch(pin.resolved, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || response.redirected || response.url !== pin.resolved || !response.body) throw fail();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length; if (size > 32_000_000) throw fail(); chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

/** Fixed lockfile closure only. Reuses the unchanged legacy archive validator:
 * SHA512 before bounded decompression, regular USTAR files only, no links,
 * traversal, lifecycle hooks or executable package scripts. Complete packages
 * preserve dynamic WASM/native binaries, PDF font data and license files. */
export async function installSharedRuntimePackages(root, destination, dependencies = {}) {
  const pins = await readSharedRuntimePackages(root), expected = await readSharedRuntimeFilePins(root), hashes = {};
  for (const pin of pins) {
    const files = readLogoRuntimeArchive(pin, await (dependencies.download ?? download)(pin));
    const prefix = `node_modules/${pin.name}/`;
    if (files.size !== Object.keys(expected).filter(name => name.startsWith(prefix)).length
      || [...files].some(([relative, bytes]) => expected[prefix + relative] !== sha256(bytes))) throw fail();
    for (const [relative, bytes] of files) {
      const output = path.join(destination, "node_modules", pin.name, relative);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, bytes, { flag: "wx", mode: 0o644 });
      hashes[`node_modules/${pin.name}/${relative}`] = sha256(bytes);
    }
  }
  if (JSON.stringify(hashes) !== JSON.stringify(expected)) throw fail();
  return { version: 1, platform: "linux", arch: "x64", libc: "glibc", packages: pins, files: hashes };
}
