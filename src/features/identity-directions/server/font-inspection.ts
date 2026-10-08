import "server-only";
import { createHash } from "node:crypto";
import nodeModule from "node:module";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { fontTextCheckSchema, type FontTextCheck, type PermittedFont } from "@/domain/logo-directions";
import { fontPurposeAllowed } from "../model/font-rights";
import { fontCheckBinding } from "../model/font-check-binding";

export const MAX_FONT_BYTES = 10_485_760;
const inspectionSchema = z.strictObject({ family: z.string().min(1).max(200), postscriptName: z.string().min(1).max(200), codePoints: z.array(z.number().int().min(0).max(0x10ffff)).max(200_000), variations: z.record(z.string().max(4), z.strictObject({ min: z.number().finite(), default: z.number().finite(), max: z.number().finite() })), weight: z.number().int().min(1).max(1000), italic: z.boolean() });
export type FontInspection = z.infer<typeof inspectionSchema>;
const inspector = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const fontkit = require(workerData.module);
  const font = fontkit.create(Buffer.from(workerData.bytes));
  if (font.fonts || !font.characterSet || !font.familyName || !font.postscriptName) throw new Error('Unsupported font');
  const axes = Object.fromEntries(Object.entries(font.variationAxes || {}).map(([k,v]) => [k,{min:v.min,default:v.default,max:v.max}]));
  const os2 = font['OS/2'];
  parentPort.postMessage({ok:true,data:{family:font.familyName,postscriptName:font.postscriptName,codePoints:font.characterSet,variations:axes,weight:os2?.usWeightClass,italic:!!(os2?.fsSelection?.italic || font.italicAngle)}});
} catch { parentPort.postMessage({ok:false}); }
`;
const requireHere = nodeModule.createRequire(join(process.cwd(), "package.json"));
let inspections = 0;

/** Untrusted parsers run in a memory- and time-bounded worker, never the web event loop. */
export async function inspectFontBytes(input: Uint8Array, declaredMime: string, signal?: AbortSignal): Promise<FontInspection> {
  if (!(input instanceof Uint8Array) || input.byteLength < 12 || input.byteLength > MAX_FONT_BYTES || !["font/ttf", "font/otf"].includes(declaredMime)) throw new TypeError("Use a single TTF or OTF font up to 10 MiB.");
  const bytes = input.slice(), signature = Buffer.from(bytes.subarray(0, 4)).toString("latin1");
  if (!(declaredMime === "font/ttf" && signature === "\u0000\u0001\u0000\u0000") && !(declaredMime === "font/otf" && signature === "OTTO")) throw new TypeError("The font format does not match its declared type.");
  if (signal?.aborted || inspections >= 4) throw new Error("Font inspection is unavailable. Try again.");
  inspections++;
  try {
    return await new Promise<FontInspection>((resolve, reject) => {
      const worker = new Worker(inspector, { eval: true, workerData: { module: requireHere.resolve("fontkit"), bytes }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
      let finished = false;
      const finish = (error: Error | null, value?: FontInspection) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); void worker.terminate(); if (error) reject(error); else resolve(value!); };
      const abort = () => finish(new Error("Font inspection was cancelled."));
      const timer = setTimeout(() => finish(new Error("Font inspection exceeded its time limit.")), 5_000);
      signal?.addEventListener("abort", abort, { once: true });
      worker.once("message", (value: unknown) => {
        const message = value as { ok?: boolean; data?: unknown };
        const parsed = inspectionSchema.safeParse(message?.data);
        if (!message?.ok || !parsed.success) finish(new TypeError("The font is malformed or unsupported."));
        else finish(null, parsed.data);
      });
      worker.once("error", () => finish(new TypeError("The font could not be inspected.")));
      worker.once("exit", () => { if (!finished) finish(new TypeError("The font could not be inspected.")); });
      if (signal?.aborted) abort();
    });
  } finally { inspections--; }
}
export type TypographySample = { typographyVersionId: string; styleKey: string; role: string; text: string; weight: number; style: "normal" | "italic" };
export async function inspectTypographySamples(font: PermittedFont, samples: readonly TypographySample[], signal?: AbortSignal): Promise<readonly FontTextCheck[]> {
  if (samples.length > 100 || samples.some(s => s.text.length < 1 || s.text.length > 2000 || !Number.isInteger(s.weight) || s.weight < 1 || s.weight > 1000 || !["normal", "italic"].includes(s.style))) throw new TypeError("Typography samples are invalid or too large.");
  if (font.purpose !== "render" || !fontPurposeAllowed(font.record, "render") || font.contentHash !== font.record.asset.contentHash || createHash("sha256").update(font.bytes).digest("hex") !== font.contentHash) throw new TypeError("Verified display permission and exact font bytes are required.");
  const mime = Buffer.from(font.bytes.subarray(0, 4)).toString("latin1") === "OTTO" ? "font/otf" : "font/ttf";
  const inspected = await inspectFontBytes(font.bytes, mime, signal), points = new Set(inspected.codePoints);
  return Promise.all(samples.map(async sample => {
    const missing = [...new Set(Array.from(sample.text, c => c.codePointAt(0)!).filter(point => !points.has(point)))].sort((a, b) => a - b);
    const axis = inspected.variations.wght;
    const styleSupported = (axis ? sample.weight >= axis.min && sample.weight <= axis.max : sample.weight === inspected.weight) && (sample.style === "italic") === inspected.italic;
    return fontTextCheckSchema.parse({ typographyVersionId: sample.typographyVersionId, styleKey: sample.styleKey, role: sample.role, fontVersionId: font.record.id, fontContentHash: font.contentHash,
      ...await fontCheckBinding({ ...sample, fontVersionId: font.record.id, fontContentHash: font.contentHash }), missingCodePoints: missing, styleSupported });
  }));
}
