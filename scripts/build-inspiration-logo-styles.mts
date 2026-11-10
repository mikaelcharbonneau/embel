// Writes one logo style note per Inspiration brand from its logo image, for
// src/domain/inspiration-logo-styles.json. A note is kept while its logo image
// fingerprint, note version and model are unchanged, so rerunning only pays
// for new or changed brands. Paid text requests: run deliberately, never in CI.
//
//   node --import tsx scripts/build-inspiration-logo-styles.mts
//
// The provider key comes from EMBEL_DEVELOPMENT_PROVIDER_API_KEY or the ignored
// .embel-dev/provider.env. It is never printed or written.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { LOGO_STYLE_NOTE_INSTRUCTION, LOGO_STYLE_NOTE_JSON_SCHEMA, LOGO_STYLE_NOTE_VERSION, logoStyleNoteSchema } from "../src/domain/logo-style-notes";
import { inspirationLogoStylesSchema, type InspirationLogoStyles } from "../src/domain/inspiration-logo-styles";

const root = fileURLToPath(new URL("..", import.meta.url));
const MODEL = "gpt-6.1-sol", output = path.join(root, "src/domain/inspiration-logo-styles.json");
const brands = JSON.parse(await readFile(path.join(root, "src/domain/inspiration-brands.json"), "utf8")) as {
  id: string; slug: string; parts: { part: string; image: string; contentHash: string }[] }[];

async function providerKey() {
  if (process.env.EMBEL_DEVELOPMENT_PROVIDER_API_KEY?.trim()) return process.env.EMBEL_DEVELOPMENT_PROVIDER_API_KEY.trim();
  const file = parseEnv(await readFile(path.join(root, ".embel-dev/provider.env"), "utf8"));
  if (!file.EMBEL_DEVELOPMENT_PROVIDER_API_KEY?.trim()) throw new Error("No development provider key is configured.");
  return file.EMBEL_DEVELOPMENT_PROVIDER_API_KEY.trim();
}
const apiKey = await providerKey();
let existing: InspirationLogoStyles = { version: 1, noteVersion: LOGO_STYLE_NOTE_VERSION, model: MODEL, notes: {} };
try { existing = inspirationLogoStylesSchema.parse(JSON.parse(await readFile(output, "utf8"))); } catch { /* First run. */ }
const reusable = existing.noteVersion === LOGO_STYLE_NOTE_VERSION && existing.model === MODEL;

const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
async function note(file: string) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, store: false, reasoning: { effort: "low" }, max_output_tokens: 2000,
      text: { format: { type: "json_schema", name: "logo_style_note", strict: true, schema: LOGO_STYLE_NOTE_JSON_SCHEMA } },
      input: [{ role: "user", content: [{ type: "input_text", text: LOGO_STYLE_NOTE_INSTRUCTION },
        { type: "input_image", image_url: `data:image/webp;base64,${(await readFile(file)).toString("base64")}`, detail: "high" }] }] }),
  });
  const body = await response.json() as { output?: { type: string; content?: { type: string; text?: string }[] }[]; usage?: { input_tokens?: number; output_tokens?: number }; error?: { code?: string } };
  usage.requests += 1; usage.inputTokens += body.usage?.input_tokens ?? 0; usage.outputTokens += body.usage?.output_tokens ?? 0;
  if (!response.ok) throw new Error(`Note request failed (${response.status}${body.error?.code ? ` ${body.error.code}` : ""}).`);
  const text = (body.output ?? []).filter(item => item.type === "message").flatMap(item => item.content ?? [])
    .filter(part => part.type === "output_text").map(part => part.text ?? "").join("");
  return logoStyleNoteSchema.parse(JSON.parse(text));
}

const notes: InspirationLogoStyles["notes"] = {};
const queue = [...brands];
async function worker() {
  for (let brand = queue.shift(); brand; brand = queue.shift()) {
    const logo = brand.parts.find(part => part.part === "logo");
    if (!logo) throw new Error(`${brand.slug} has no logo image.`);
    const file = path.join(root, "public", logo.image);
    if (createHash("sha256").update(await readFile(file)).digest("hex") !== logo.contentHash) throw new Error(`${brand.slug} logo differs from the catalog.`);
    const kept = reusable ? existing.notes[brand.id] : undefined;
    if (kept && kept.logoContentHash === logo.contentHash) { notes[brand.id] = kept; continue; }
    const value = await note(file);
    if (!value.symbol && !value.lettering) throw new Error(`${brand.slug} produced an empty note.`);
    notes[brand.id] = { slug: brand.slug, logoContentHash: logo.contentHash, ...value };
    console.log("noted", brand.slug);
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
const ordered = Object.fromEntries(brands.map(brand => [brand.id, notes[brand.id]!]));
const result = inspirationLogoStylesSchema.parse({ version: 1, noteVersion: LOGO_STYLE_NOTE_VERSION, model: MODEL, notes: ordered });
await writeFile(output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ brands: brands.length, ...usage }));
