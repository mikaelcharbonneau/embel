#!/usr/bin/env node
// Turns a folder of single logo images (the logo library, saved from the
// logosystem.co gallery with the owner's permission) into:
//   public/inspiration/logos/<slug>.webp          large, for the overlay
//   public/inspiration/logos/<slug>-small.webp    small, for the gallery
//   src/domain/inspiration-logos.json             compact catalog entries
//   supabase/migrations/<migration>.sql           matching catalog rows
// Usage: node scripts/build-inspiration-logos.mjs <folder> <migration file name>
// Each image becomes one Logos-tab entry named after its file. The source folder
// stays out of git. Rebuilding keeps each logo's id (a name-based UUID).
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const [source, migrationName] = process.argv.slice(2);
if (!source || !migrationName) throw new Error("Usage: build-inspiration-logos.mjs <folder> <migration file name>");

const CATALOG_VERSION = "2026-10-13.1",
  AVAILABLE_SINCE = "2026-11-24.1",
  LARGE = 1200,
  SMALL = 480;
const outDir = path.join(root, "public", "inspiration", "logos");

// Same RFC 9562 version 5 namespace as the brand boards, with a different name
// prefix, so a logo never shares an id with a board.
const namespace = Buffer.from("8d2f1c0a6b3e4d5f9a7c2e1b0f4d6a83", "hex");
function uuid5(name) {
  const bytes = createHash("sha1")
    .update(Buffer.concat([namespace, Buffer.from(name, "utf8")]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// File name to slug and display name: "nfl-plus.webp" → "nfl-plus", "NFL Plus".
// Saved-file noise ("-logo-design", a trailing copy number) is left out of the name.
const slugOf = (file) =>
  file
    .replace(/\.[^.]+$/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
function nameOf(slug) {
  const words = slug
    .replace(/-(?:logo-(?:creation|design)|logo)$/u, "")
    .replace(/-(?:jpg|png|webp)$/u, "")
    .replace(/-\d$/u, "")
    .split("-");
  return words
    .map((word) =>
      /^[a-z]+$/u.test(word) && !/[aeiouy]/u.test(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1),
    )
    .join(" ");
}
// The color around an image's edges, when its edges are one flat color, so the
// gallery can show a very wide or tall logo whole on that color.
async function edgeFill(input) {
  const size = 48,
    { data, info } = await input
      .clone()
      .resize(size, size, { fit: "fill" })
      .flatten({ background: "#ffffff" })
      .raw()
      .toBuffer({ resolveWithObject: true });
  const pixels = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (x > 1 && y > 1 && x < size - 2 && y < size - 2) continue;
      const at = (y * size + x) * info.channels;
      pixels.push([data[at], data[at + 1], data[at + 2]]);
    }
  const mean = [0, 1, 2].map((channel) => pixels.reduce((sum, pixel) => sum + pixel[channel], 0) / pixels.length);
  const spread = Math.sqrt(
    pixels.reduce(
      (sum, pixel) => sum + pixel.reduce((total, value, channel) => total + (value - mean[channel]) ** 2, 0),
      0,
    ) /
      pixels.length /
      3,
  );
  return spread <= 10 ? `#${mean.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}` : undefined;
}

const boardSlugs = new Set(
  JSON.parse(await readFile(path.join(root, "src", "domain", "inspiration-brands.json"), "utf8")).map((b) => b.slug),
);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const files = (await readdir(source)).filter((file) => /\.(?:webp|jpe?g|png|gif)$/iu.test(file)).sort();
const logos = [],
  skipped = [],
  seenSlugs = new Set(),
  seenSources = new Map();
for (const file of files) {
  const slug = slugOf(file);
  const bytes = await readFile(path.join(source, file));
  const sourceHash = sha256(bytes);
  if (seenSources.has(sourceHash)) {
    skipped.push(`${file} (same image as ${seenSources.get(sourceHash)})`);
    continue;
  }
  if (!slug || seenSlugs.has(slug) || boardSlugs.has(slug)) {
    skipped.push(`${file} (name already used)`);
    continue;
  }
  seenSources.set(sourceHash, file);
  seenSlugs.add(slug);
  const input = sharp(bytes).rotate();
  const large = await input
    .clone()
    .resize({ width: LARGE, withoutEnlargement: true })
    .webp({ quality: 78, effort: 6 })
    .toBuffer({ resolveWithObject: true });
  const small = await input
    .clone()
    .resize({ width: SMALL, withoutEnlargement: true })
    .webp({ quality: 76, effort: 6 })
    .toBuffer();
  await writeFile(path.join(outDir, `${slug}.webp`), large.data);
  await writeFile(path.join(outDir, `${slug}-small.webp`), small);
  const fill = await edgeFill(input);
  logos.push({
    id: uuid5(`embel-inspiration-logo:${slug}`),
    slug,
    brand: nameOf(slug),
    width: large.info.width,
    height: large.info.height,
    contentHash: sha256(large.data),
    ...(fill ? { fill } : {}),
  });
}

await writeFile(path.join(root, "src", "domain", "inspiration-logos.json"), `${JSON.stringify(logos)}\n`);
// The catalog row holds the same descriptor the app builds from the entry (see
// expandInspirationLogo in src/domain/inspiration.ts).
const descriptor = (logo) => {
  const image = `/inspiration/logos/${logo.slug}.webp`,
    description = `${logo.brand} logo`;
  return {
    id: logo.id,
    slug: logo.slug,
    brand: logo.brand,
    kind: "logo",
    description,
    image,
    width: logo.width,
    height: logo.height,
    contentHash: logo.contentHash,
    elements: ["logo"],
    tags: [],
    availableSince: AVAILABLE_SINCE,
    parts: [
      {
        part: "logo",
        image,
        thumbnail: `/inspiration/logos/${logo.slug}-small.webp`,
        width: logo.width,
        height: logo.height,
        contentHash: logo.contentHash,
        ...(logo.fill ? { fill: logo.fill } : {}),
        description,
      },
    ],
  };
};
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
await writeFile(
  path.join(root, "supabase", "migrations", migrationName),
  `-- Logo library: one immutable Inspiration catalog row per logo, shown in the
-- Logos tab (${logos.length} logos, saved from the logosystem.co gallery with the
-- owner's permission; see docs/inspiration-logo-library.md). A logo can only be
-- liked as a logo. Generated by scripts/build-inspiration-logos.mjs.
-- Additive: apply after the matching web release; no change to RLS or access.
begin;
insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values
${logos
  .map(
    (logo) =>
      `(${quote(logo.id)},${quote(CATALOG_VERSION)},${quote(JSON.stringify(descriptor(logo)))}::jsonb,array['logo']::text[])`,
  )
  .join(",\n")}
on conflict (id) do nothing;
commit;
`,
);
console.log(`${logos.length} logos written. Skipped: ${skipped.join(", ") || "none"}`);
