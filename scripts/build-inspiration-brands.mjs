#!/usr/bin/env node
// Turns the raw brand folders in inspiration/<slug>/ (five images each: logo,
// color palette, typography, social profile, brand poster) into:
//   public/inspiration/brands/<slug>/<file>.webp          large, for the overlay
//   public/inspiration/brands/<slug>/<file>-small.webp    small, for the gallery
//   src/domain/inspiration-brands.json                    catalog descriptors
//   supabase/migrations/<migration>.sql                   matching catalog rows
// Usage: node scripts/build-inspiration-brands.mjs <descriptions.json> [migration file name]
// The descriptions file holds each brand's name, description, tags and one
// plain description per part. Raw folders stay out of git (.gitignore).
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "inspiration");
const [descriptionsPath, migrationName = "20261108120000_inspiration_brands.sql"] = process.argv.slice(2);
if (!descriptionsPath) throw new Error("Usage: build-inspiration-brands.mjs <descriptions.json> [migration file name]");
const descriptions = JSON.parse(await readFile(descriptionsPath, "utf8"));

const CATALOG_VERSION = "2026-10-13.1",
  AVAILABLE_SINCE = "2026-11-08.1";
// Each image is one part of the brand. A part's like is stored as the matching
// reference element, so the existing saved-choice contract carries it.
const parts = [
  { prefix: "01-", part: "logo", element: "logo" },
  { prefix: "02-", part: "colors", element: "colors" },
  { prefix: "03-", part: "typefaces", element: "typography" },
  { prefix: "04-", part: "socials", element: "composition" },
  { prefix: "05-", part: "visuals", element: "images" },
];
// Database order for reference elements (fluid_private.reference_elements).
const elementOrder = ["logo", "typography", "colors", "graphics", "images", "composition"];
const LARGE = 1600,
  SMALL = 800;

// Stable name-based UUID (RFC 9562 version 5) so rebuilding keeps each brand's id.
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
// The color around an image's edges, when its edges are one flat color. The
// gallery shows a very wide or tall image whole on that color, without visible
// bands, instead of cropping it; photos with busy edges are cropped to fill.
async function edgeFill(input) {
  const size = 48,
    { data, info } = await input
      .clone()
      .resize(size, size, { fit: "fill" })
      .removeAlpha()
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
const text = (value, max, label) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new Error(`${label}: expected text up to ${max} characters`);
  return value.trim();
};

const brands = [],
  skipped = [];
for (const slug of (await readdir(source, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()) {
  const files = (await readdir(path.join(source, slug))).filter((file) => !file.startsWith("."));
  const matched = parts.map((part) => files.find((file) => file.startsWith(part.prefix)));
  if (matched.some((file) => !file) || files.length !== parts.length) {
    skipped.push(`${slug} (${files.length} images)`);
    continue;
  }
  const described = descriptions[slug];
  if (!described) {
    skipped.push(`${slug} (no description)`);
    continue;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new Error(`${slug}: folder names must be lowercase words joined by hyphens`);
  const outDir = path.join(root, "public", "inspiration", "brands", slug);
  await mkdir(outDir, { recursive: true });
  const images = [];
  for (const [index, part] of parts.entries()) {
    const base = matched[index].replace(/\.[^.]+$/, "");
    const input = sharp(path.join(source, slug, matched[index])).rotate();
    const large = await input
      .clone()
      .resize({ width: LARGE, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    const small = await input
      .clone()
      .resize({ width: SMALL, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    await writeFile(path.join(outDir, `${base}.webp`), large.data);
    await writeFile(path.join(outDir, `${base}-small.webp`), small);
    images.push({
      part: part.part,
      image: `/inspiration/brands/${slug}/${base}.webp`,
      thumbnail: `/inspiration/brands/${slug}/${base}-small.webp`,
      width: large.info.width,
      height: large.info.height,
      contentHash: sha256(large.data),
      ...(await edgeFill(input).then((fill) => (fill ? { fill } : {}))),
      description: text(described.parts?.[part.part], 200, `${slug} ${part.part}`),
    });
  }
  const tags = Array.isArray(described.tags)
    ? described.tags.map((tag) => text(tag, 40, `${slug} tag`).toLowerCase()).slice(0, 4)
    : [];
  const logo = images[0];
  brands.push({
    id: uuid5(`embel-inspiration-brand:${slug}`),
    slug,
    brand: text(described.name, 80, `${slug} name`),
    kind: "identity",
    description: text(described.description, 240, `${slug} description`),
    image: logo.image,
    width: logo.width,
    height: logo.height,
    contentHash: logo.contentHash,
    elements: elementOrder.filter((element) => parts.some((part) => part.element === element)),
    tags,
    availableSince: AVAILABLE_SINCE,
    parts: images,
  });
  process.stdout.write(`${slug} `);
}

await writeFile(path.join(root, "src", "domain", "inspiration-brands.json"), `${JSON.stringify(brands, null, 2)}\n`);
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const rows = brands.map(
  (brand) =>
    `insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values(${quote(brand.id)},${quote(CATALOG_VERSION)},${quote(JSON.stringify(brand))}::jsonb,array[${brand.elements.map(quote).join(",")}]::text[]);`,
);
await writeFile(
  path.join(root, "supabase", "migrations", migrationName),
  `-- Inspiration brands: one immutable catalog row per brand. Each brand has five
-- images (logo, colors, typefaces, socials, visuals); liking the whole brand is
-- the choice's ensemble flag, and liking a part is that part's reference element.
-- Apply with the matching web release; no change to RLS or account access.
begin;
${rows.join("\n")}

-- The earlier single-image designs are no longer shown. Saved likes on them are
-- test data before launch: remove them and advance each affected project's
-- selection revision so logo inputs and reviewed directions see the change.
-- Deleted projects (or ones being deleted) keep their records: their content is
-- frozen by the project lifecycle guard and is never shown.
with removed as (
 delete from public.project_inspiration_choices c using fluid_private.inspiration_catalog a, public.projects p
 where a.id=c.reference_id and not (a.descriptor ? 'parts')
  and p.id=c.project_id and p.owner_id=c.owner_id and p.deleted_at is null and p.deletion_requested_at is null
 returning c.project_id,c.owner_id
)
update public.project_inspiration_heads h set revision=h.revision+1
 from (select distinct project_id,owner_id from removed) r
 where h.project_id=r.project_id and h.owner_id=r.owner_id;
commit;
`,
);
console.log(`\n${brands.length} brands written. Skipped: ${skipped.join(", ") || "none"}`);
