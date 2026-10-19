import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const names = ["sharp", "@img/colour", "detect-libc", "semver", "@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"];
const fail = () => new Error("Logo Linux runtime package verification failed.");

export async function readLogoRuntimePackages(root) {
  const pins = JSON.parse(await readFile(path.join(root, "services/logo-worker/runtime-packages.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  if (!Array.isArray(pins) || JSON.stringify(pins.map(value => value.name)) !== JSON.stringify(names)) throw fail();
  for (const pin of pins) {
    const locked = lock.packages[`node_modules/${pin.name}`];
    if (!locked || JSON.stringify(pin) !== JSON.stringify({ name: pin.name, version: locked.version, resolved: locked.resolved, integrity: locked.integrity })
      || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(pin.integrity) || !/^https:\/\/registry\.npmjs\.org\/[A-Za-z0-9@/._-]+\.tgz$/u.test(pin.resolved)) throw fail();
  }
  return pins;
}

/** A tiny, fail-closed reader for the pinned npm USTAR archives. No symlinks,
 * hardlinks, devices, traversal, metadata extensions, executable scripts or npm
 * lifecycle hooks are evaluated. Archive identity is checked before parsing. */
export function readLogoRuntimeArchive(pin, compressed) {
  if (!(compressed instanceof Uint8Array) || compressed.length > 32_000_000
    || `sha512-${createHash("sha512").update(compressed).digest("base64")}` !== pin.integrity) throw fail();
  const tar = gunzipSync(compressed, { maxOutputLength: 128_000_000 }), files = new Map();
  if (tar.length % 512 !== 0) throw fail();
  let terminated = false;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      if (!tar.subarray(offset).every(byte => byte === 0)) throw fail();
      terminated = true;
      break;
    }
    const string = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/su, "");
    const number = (start, end) => {
      const value = string(start, end).trim(); if (!/^[0-7]+$/u.test(value)) throw fail();
      const parsed = Number.parseInt(value, 8); if (!Number.isSafeInteger(parsed)) throw fail(); return parsed;
    };
    const expectedChecksum = number(148, 156);
    let checksum = 0;
    for (let index = 0; index < header.length; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== expectedChecksum) throw fail();
    const prefix = string(345, 500), name = `${prefix ? `${prefix}/` : ""}${string(0, 100)}`, type = header[156];
    const size = number(124, 136);
    if (!name.startsWith("package/") || name.includes("\\") || /[\x00-\x1f\x7f]/u.test(name)
      || name.replace(/\/$/u, "").split("/").some(part => !part || part === "." || part === "..") || size > 64_000_000 || offset + size > tar.length) throw fail();
    if (type === 53) { if (size) throw fail(); }
    else if (type === 0 || type === 48) {
      const relative = name.slice(8);
      if (!relative || relative.endsWith("/") || files.has(relative)) throw fail();
      files.set(relative, Buffer.from(tar.subarray(offset, offset + size)));
    } else throw fail();
    offset += Math.ceil(size / 512) * 512;
  }
  const manifest = JSON.parse(files.get("package.json")?.toString("utf8") ?? "null");
  if (!terminated || manifest?.name !== pin.name || manifest.version !== pin.version) throw fail();
  return files;
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

export async function installLogoRuntimePackages(root, destination) {
  const pins = await readLogoRuntimePackages(root), hashes = {};
  for (const pin of pins) {
    const files = readLogoRuntimeArchive(pin, await download(pin));
    for (const [relative, bytes] of files) {
      const output = path.join(destination, "node_modules", pin.name, relative);
      await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, bytes, { flag: "wx", mode: 0o644 });
      hashes[`node_modules/${pin.name}/${relative}`] = createHash("sha256").update(bytes).digest("hex");
    }
  }
  return { platform: "linux", arch: "x64", libc: "glibc", packages: pins, files: hashes };
}
