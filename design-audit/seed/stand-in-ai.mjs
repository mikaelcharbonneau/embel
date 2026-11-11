#!/usr/bin/env node
// Design-audit stand-in for the OpenAI endpoints the generation engine calls. Based on the
// repository's journey stand-in (tests/journey/fake-openai.mjs), with three additions:
//   1. Brand-specific answers from brands.mjs, so every seeded brand has its own content.
//   2. Showcase images: served from design-audit/seed/showcase/<brand>/. Only when started with
//      AUDIT_REAL_IMAGES=1 (seed.mjs --real-images) is a missing showcase image fetched once from
//      the real OpenAI Images API with the local development key and cached. Never otherwise.
//   3. A control endpoint for audit recipes (slow, hold, fail), see README "State recipes".
//
// Endpoints (loopback only, port AUDIT_AI_PORT, default 3186):
//   POST /v1/responses, GET /v1/responses/:id, POST /v1/responses/:id/cancel, POST /v1/responses/input_tokens
//   POST /v1/images/generations | /v1/images/edits
//   GET  /__health, GET /__stats, GET /__mode, POST /__mode  {text?, images?, delayMs?}
//        text:   "normal" | "slow" | "hold" | "fail"
//        images: "normal" | "slow" | "hold" | "refuse" | "error"
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import sharp from "sharp";
import { BRANDS } from "./brands.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const SHOWCASE = path.join(here, "showcase");
const PORT = Number(process.env.AUDIT_AI_PORT ?? "3186");
const SEEDING = process.env.AUDIT_SEEDING === "1";
const REAL_IMAGES = process.env.AUDIT_REAL_IMAGES === "1";
const REAL_LIMIT = Number(process.env.AUDIT_REAL_IMAGE_LIMIT ?? "24");

const mode = { text: "normal", images: "normal", delayMs: 60_000 };
const WORK_MS = Number(process.env.AUDIT_AI_WORK_MS ?? "1200");
const stats = { responses: {}, images: { placeholder: 0, cached: 0, real: 0, refused: 0 }, cancelled: 0, unknown: 0 };
const responses = new Map();
let sequence = 0;

// Brand lookup ------------------------------------------------------------------------------
const fold = (text) => String(text).normalize("NFC").toLowerCase();
/** The seeded brand a request is about: its saved name or the start of its brief appears in it. */
function brandOf(text) {
  const haystack = fold(text);
  return (
    BRANDS.find((b) => haystack.includes(fold(JSON.stringify(b.name).slice(1, -1)))) ??
    BRANDS.find((b) => haystack.includes(fold(JSON.stringify(b.brief.slice(0, 30)).slice(1, -1)))) ??
    null
  );
}

// Text answers ------------------------------------------------------------------------------
const option = (index, label, description, payload) => ({
  label,
  description,
  recommended: index === 0,
  recommendationReason: index === 0 ? "It fits the offering and audience most closely." : null,
  payload,
});
const slug = (text) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const GENERIC = {
  competitors: [
    ["Northloaf Studio", "A well-known local competitor."],
    ["Crumb & Co", "A national chain in the same space."],
    ["Office Oven", "An online-first newcomer."],
  ],
  audiences: [
    ["Local customers", "People nearby who buy weekly."],
    ["Small businesses", "Teams that order for the office."],
    ["Gift buyers", "People shopping for someone else."],
  ],
  positionings: [
    ["Fresh every Monday", "Reliability first."],
    ["The neighbourhood favourite", "Local and personal."],
    ["Without the errand", "Convenience above all."],
  ],
  personalities: [
    ["Warm and dependable", "Friendly and steady."],
    ["Lively and bold", "Energetic and loud."],
    ["Refined and calm", "Quiet and precise."],
  ],
  slogans: ["Made for your Monday", "Good things, nearby", "Simply better"],
};
const competitorUrl = (name) => `https://${slug(name)}.example.com/`;

function strategyReply(request, b) {
  const content = JSON.parse(request.input[0].content);
  const turn = content.currentTurn;
  if (!turn) throw new Error("Only guided Strategy requests are supported");
  const data = (key) => b?.[key] ?? GENERIC[key];
  const common = { targetStage: null, selection: null };
  if (turn.purpose === "message")
    return {
      ...common,
      kind: "answer",
      message: "Thanks, that helps. Choose an option when you are ready.",
      question: null,
      options: [],
    };
  const choices = (message, question, options) => ({ ...common, kind: "choices", message, question, options });
  switch (turn.stage) {
    case "competitors":
      return choices(
        "Here are competitors research found. Each one links to the page it was found on.",
        "Which competitors should we keep in mind?",
        data("competitors").map(([name, description], index) =>
          option(index, name, description, {
            name,
            relevance: description,
            url: competitorUrl(name),
            sourceUrls: [competitorUrl(name)],
          }),
        ),
      );
    case "audience":
      return choices(
        "These audiences look promising.",
        "Who should the brand speak to first?",
        data("audiences").map(([label, description], index) =>
          option(index, label, description, {
            label,
            needs: ["Clear information before buying", "A brand they can trust"],
            reason: description,
          }),
        ),
      );
    case "positioning":
      return choices(
        "Three ways to stand apart.",
        "Which positioning fits best?",
        data("positionings").map(([angle, why], index) =>
          option(index, angle, `Lead with: ${angle}.`, {
            angle,
            statement: `For our audience, we are ${angle.charAt(0).toLowerCase() + angle.slice(1)}.`,
            why,
            leads: ["Trust", "Clarity"],
          }),
        ),
      );
    case "personality":
      return choices(
        "Three personality directions.",
        "Which personality feels right?",
        data("personalities").map(([label, expression], index) =>
          option(index, label, expression, {
            profile: {
              sincerity: 80 - index * 20,
              excitement: 40 + index * 20,
              competence: 70,
              sophistication: 30 + index * 25,
              ruggedness: 20,
            },
            traits: label.split(/ and | et /u),
            toneExample: `${b?.name ?? "We"}: ${expression}`,
            expression,
          }),
        ),
      );
    case "slogan":
      return choices(
        "A few slogan ideas.",
        "Which slogan do you like?",
        data("slogans").map((slogan, index) => option(index, slogan, "Short and easy to remember.", { slogan })),
      );
    default:
      throw new Error(`Unknown Strategy stage ${turn.stage}`);
  }
}

// Names: pronounceable words plus, first, the brand's planned name in a construction that passes.
const CONSONANTS = "bdfgklmnprstvz",
  VOWELS = "aeiou";
let nameCounter = 0;
function word() {
  let n = nameCounter++ + 37,
    text = "";
  for (let i = 0; i < 3; i++) {
    text += CONSONANTS[n % CONSONANTS.length] + VOWELS[Math.floor(n / CONSONANTS.length) % VOWELS.length];
    n = Math.floor(n / (CONSONANTS.length * VOWELS.length)) + i + 3;
  }
  return text + CONSONANTS[nameCounter % CONSONANTS.length];
}
const capital = (text) => text[0].toUpperCase() + text.slice(1);
function candidate(approach) {
  const a = word(),
    b = word(),
    c = word();
  const base = { rationale: `Built from ${a} to suggest warmth and care.`, primaryApproach: approach };
  switch (approach) {
    case "invented":
      return { ...base, value: capital(a), construction: [] };
    case "real_words":
      return { ...base, value: capital(a), construction: [a] };
    case "modified":
      return { ...base, value: capital(a) + "a", construction: [a] };
    case "blends":
      return { ...base, value: capital(a.slice(0, 3) + b.slice(2)), construction: [a, b] };
    case "compounds":
      return { ...base, value: capital(a) + b, construction: [a, b] };
    case "phrases":
      return { ...base, value: `${capital(a)} ${capital(b)}`, construction: [a, b] };
    case "initials":
      return { ...base, value: (a[0] + b[0] + c[0] + a[1]).toUpperCase(), construction: [a, b, c, a.slice(1)] };
    default:
      return { ...base, value: capital(a), construction: [`${a} (Latin)`] };
  }
}
function plannedName(b) {
  const words = b.name.split(/\s+/u);
  const rationale = `${b.name} says what the brand is in plain words.`;
  if (words.length > 1)
    return {
      approach: "phrases",
      value: { value: b.name, construction: words.map((w) => w.toLowerCase()), rationale, primaryApproach: "phrases" },
    };
  return {
    approach: "real_words",
    value: { value: b.name, construction: [b.name.toLowerCase()], rationale, primaryApproach: "real_words" },
  };
}
const namesServed = new Set();
function namingReply(request, b) {
  const paragraphs = String(request.input).split("\n\n");
  const plan = JSON.parse(paragraphs.at(-1)).approachPlan;
  const candidates = plan.flatMap((slot) => Array.from({ length: slot.request }, () => candidate(slot.approach)));
  if (b && !namesServed.has(b.key)) {
    const planned = plannedName(b);
    const at = candidates.findIndex((c) => c.primaryApproach === planned.approach);
    if (at >= 0) {
      candidates[at] = planned.value;
      namesServed.add(b.key);
    }
  }
  return { candidates };
}

// Creative-direction specifications.
const PALETTES = [
  ["#1F4E5F", "#E07A5F"],
  ["#3D405B", "#81B29A"],
  ["#5C3D2E", "#F2CC8F"],
];
const GRAPHICS = ["rounded_shapes", "fine_lines", "bold_blocks"],
  LAYOUTS = ["editorial", "centered", "split"];
function pickFont(fonts, family, fallbackIndex) {
  return fonts.find((f) => f.family === family) ?? fonts[fallbackIndex % fonts.length];
}
function identityReply(request, b) {
  const text = String(request.input[0].content);
  const data = JSON.parse(text.slice(text.indexOf("{")));
  const n = data.ordinal,
    fonts = data.supportedTypography;
  const [headingFamily, bodyFamily] = b?.fonts?.[(n - 1) % 3] ?? [];
  const heading = pickFont(fonts, headingFamily, n - 1),
    body = pickFont(fonts, bodyFamily, n);
  const weight = (font, wanted) => Math.min(font.maxWeight, Math.max(font.minWeight, wanted));
  const [primary, accent] = (b?.palette ?? PALETTES)[(n - 1) % 3];
  const story = b?.directions?.[(n - 1) % 3] ?? `A calm supporting system around the chosen logo, option ${n}.`;
  // "Direction N:" lets the image side recognise which board this is (showcase cache key).
  const note = { direction: `Direction ${n}: ${story}`, usageNotes: "Keep clear space around the logo." };
  return {
    components: {
      logo: note,
      colors: {
        swatches: [
          { key: "primary", name: "Primary", hex: primary },
          { key: "accent", name: "Accent", hex: accent },
          { key: "background", name: "Background", hex: "#FBF9F4" },
          { key: "text", name: "Text", hex: "#141414" },
        ],
        usageNotes: "Primary for large areas, accent sparingly for highlights.",
      },
      typography: {
        styles: [
          { key: "heading", role: "Heading", family: heading.family, weight: weight(heading, 600), style: "normal" },
          { key: "body", role: "Body", family: body.family, weight: weight(body, 400), style: "normal" },
        ],
        usageNotes: "Headings in the heading face, everything else in the body face.",
      },
      graphics: { ...note, direction: `Supporting graphics for direction ${n}: ${story}` },
      imagery: { ...note, direction: `Imagery for direction ${n}: warm natural light, real settings.` },
      composition: { ...note, direction: `Composition for direction ${n}: generous margins, one focal point.` },
    },
    boardPrompt: `A professional brand board for ${b?.name ?? "the brand"}: ${story}`,
    applicationDesign: {
      version: 1,
      graphic: GRAPHICS[(n - 1) % 3],
      layout: LAYOUTS[(n - 1) % 3],
      paletteRoles: { primary: "primary", accent: "accent", background: "background", text: "text" },
      headingStyleKey: "heading",
      bodyStyleKey: "body",
    },
  };
}

function classify(request) {
  const format = request.text?.format;
  if (format?.type === "json_schema" && format.name === "naming_generation_v2") return "naming";
  if (format?.type === "json_schema" && String(format.name).startsWith("strategy_"))
    return format.name.replace("_", ".");
  if (format?.type === "json_object" && String(request.input?.[0]?.content ?? "").includes("supportedTypography"))
    return "identity.spec";
  if (format?.type === "json_schema" && format.name === "logo_style_note") return "logo.style_note";
  return "other";
}
function envelope(entry, status) {
  return {
    id: entry.id,
    object: "response",
    created_at: Math.floor(entry.createdAt / 1000),
    status,
    background: true,
    model: entry.request.model,
    service_tier: "default",
    error: null,
    incomplete_details: null,
    output: [],
    usage: null,
  };
}
function completedBody(entry) {
  const { request, kind } = entry;
  const b = brandOf(JSON.stringify(request));
  const value =
    kind === "naming"
      ? namingReply(request, b)
      : kind === "identity.spec"
        ? identityReply(request, b)
        : kind.startsWith("strategy.")
          ? strategyReply(request, b)
          : kind === "logo.style_note"
            ? {
                symbol: "Simple geometric shapes with soft, rounded corners and generous negative space.",
                lettering: "Clean, open geometric sans-serif lettering.",
              }
            : { note: "Clean geometric line work with generous negative space." };
  const output = [];
  if (kind === "strategy.competitors") {
    const list = b?.competitors ?? GENERIC.competitors;
    output.push({
      type: "web_search_call",
      id: `ws_${entry.id}`,
      status: "completed",
      action: {
        type: "search",
        query: "competitors",
        sources: list.map(([name]) => ({ type: "url", url: competitorUrl(name), title: name })),
      },
    });
  }
  output.push({
    type: "message",
    id: `msg_${entry.id}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }],
  });
  return {
    ...envelope(entry, "completed"),
    output,
    usage: {
      input_tokens: 1200,
      output_tokens: 400,
      total_tokens: 1600,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}
function current(entry) {
  if (entry.final) return entry.final;
  if (entry.mode === "hold") return envelope(entry, "in_progress");
  const wait = entry.mode === "slow" ? entry.delayMs : WORK_MS;
  if (Date.now() - entry.createdAt < wait) return envelope(entry, "in_progress");
  if (entry.mode === "fail") {
    entry.final = {
      ...envelope(entry, "failed"),
      error: { code: "server_error", message: "stand-in failure (recipe)" },
    };
    return entry.final;
  }
  try {
    entry.final = completedBody(entry);
  } catch (error) {
    console.error(`stand-in-ai: ${entry.kind} failed: ${error.message}`);
    entry.final = {
      ...envelope(entry, "failed"),
      error: { code: "server_error", message: "stand-in could not answer" },
    };
  }
  return entry.final;
}

// Images ------------------------------------------------------------------------------------
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const SHAPES = [
  (n) => `<circle cx="512" cy="430" r="${200 + (n % 3) * 20}" fill="none" stroke="#000" stroke-width="56"/>`,
  () => `<rect x="300" y="220" width="424" height="424" rx="96" fill="#000"/>`,
  () => `<path d="M512 200 L760 640 L264 640 Z" fill="#000"/>`,
  () => `<path d="M300 640 Q512 120 724 640" fill="none" stroke="#000" stroke-width="60" stroke-linecap="round"/>`,
  () => `<g fill="#000"><circle cx="400" cy="430" r="120"/><circle cx="624" cy="430" r="120"/></g>`,
  () => `<path d="M330 260 h364 v120 h-242 v80 h182 v120 h-182 v80 h-122 z" fill="#000"/>`,
];
/** A black-and-white placeholder logo on transparency (passes the Logo raster checks). */
async function placeholderLogo(n, name) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">${SHAPES[n % SHAPES.length](n)}` +
    `<text x="512" y="800" font-family="Helvetica, Arial, sans-serif" font-size="64" font-weight="700" text-anchor="middle" fill="#000">${esc(name ?? "Brand")}</text>` +
    `<text x="512" y="880" font-family="Helvetica, Arial, sans-serif" font-size="34" letter-spacing="6" text-anchor="middle" fill="#555">TEST DATA · PLACEHOLDER #${n + 1}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
/** An opaque, full-colour placeholder board, clearly marked as test data. */
async function placeholderBoard(n, b) {
  const [primary, accent] = (b?.palette ?? PALETTES)[n % 3];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#FBF9F4"/>` +
    `<rect x="64" y="64" width="560" height="560" fill="${primary}"/><circle cx="800" cy="300" r="150" fill="${accent}"/>` +
    `<rect x="664" y="500" width="296" height="124" fill="${accent}" opacity="0.35"/>` +
    `<text x="96" y="140" font-family="Helvetica, Arial, sans-serif" font-size="44" font-weight="700" fill="#fff">${esc(b?.name ?? "Brand")}</text>` +
    `<text x="64" y="740" font-family="Helvetica, Arial, sans-serif" font-size="56" font-weight="700" fill="#141414">Direction ${n + 1}</text>` +
    `<text x="64" y="820" font-family="Helvetica, Arial, sans-serif" font-size="32" letter-spacing="6" fill="#555">TEST DATA · PLACEHOLDER BOARD #${n + 1}</text>` +
    `<rect x="64" y="880" width="120" height="60" fill="${primary}"/><rect x="200" y="880" width="120" height="60" fill="${accent}"/>` +
    `<rect x="336" y="880" width="120" height="60" fill="#141414"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function imageFields(request, body) {
  if (String(request.headers["content-type"] ?? "").startsWith("application/json"))
    return JSON.parse(body.toString("utf8"));
  const form = await new Response(body, { headers: { "content-type": request.headers["content-type"] } }).formData();
  return Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === "string"));
}
const counters = new Map();
const next = (key) => {
  const n = (counters.get(key) ?? 0) + 1;
  counters.set(key, n);
  return n;
};
/** Which image this is, so a showcase brand's images map to the same files on every reseed. */
function imageKey(fields, b) {
  const prompt = String(fields.prompt ?? "");
  if (fields.background === "opaque") {
    const m = /Direction (\d):/u.exec(prompt);
    return { kind: "board", file: `board-${m ? m[1] : next(`${b?.key}:board`)}.png` };
  }
  if (prompt.includes("Refine the first image"))
    return { kind: "refine", file: `refine-${next(`${b?.key}:refine`)}.png` };
  const type = /Assigned logo type: ([^.\n]+)/u.exec(prompt)?.[1] ?? "";
  const direction = /Assigned direction: ([^.\n]+)/u.exec(prompt)?.[1] ?? String(next(`${b?.key}:logo`));
  const id = createHash("sha256").update(`${type}|${direction}`).digest("hex").slice(0, 10);
  return { kind: "logo", file: `logo-${id}.png` };
}

let realCalls = 0;
const LEDGER = path.join(SHOWCASE, "real-calls.jsonl");
/** Every real call ever sent (all runs): one line per call, written BEFORE it is sent. */
const ledgerCount = () => (existsSync(LEDGER) ? readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).length : 0);
const TOTAL_LIMIT = Number(process.env.AUDIT_REAL_IMAGE_TOTAL_LIMIT ?? "48");
const keyFile = path.join(repo, ".embel-dev/provider.env");
function realKey() {
  const value = parseEnv(readFileSync(keyFile, "utf8")).EMBEL_DEVELOPMENT_PROVIDER_API_KEY;
  if (!value) throw new Error("No development provider key in .embel-dev/provider.env");
  return value;
}
const inflight = new Map();
/**
 * Sends the app's exact image request to the real Images API once, with the development key,
 * and saves the image to `target` before anything else can fail. Concurrent or retried requests
 * for the same target share one call. Failures are answered as refusals (400) so the engine does
 * not retry them into more paid calls.
 */
function realImage(req, body, route, target) {
  if (inflight.has(target)) return inflight.get(target);
  const work = (async () => {
    if (realCalls >= REAL_LIMIT) throw new Error(`real image limit ${REAL_LIMIT} for this run reached`);
    if (ledgerCount() >= TOTAL_LIMIT) throw new Error(`total real image limit ${TOTAL_LIMIT} reached`);
    realCalls++;
    mkdirSync(path.dirname(target), { recursive: true });
    appendFileSync(
      LEDGER,
      JSON.stringify({ at: new Date().toISOString(), route, target: path.relative(SHOWCASE, target) }) + "\n",
    );
    const response = await fetch(`https://api.openai.com${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${realKey()}`, "content-type": req.headers["content-type"] },
      body,
      signal: AbortSignal.timeout(300_000),
    });
    const json = await response.json().catch(() => ({}));
    if (response.ok && json.data?.[0]?.b64_json) {
      const png = Buffer.from(json.data[0].b64_json, "base64");
      writeFileSync(target, png);
      writeFileSync(
        target.replace(/\.png$/u, ".usage.json"),
        JSON.stringify({ route, usage: json.usage ?? null }, null, 2),
      );
      return { png, usage: json.usage };
    }
    throw new Error(`real image call failed: HTTP ${response.status} ${json.error?.code ?? ""}`);
  })();
  inflight.set(target, work);
  work.catch(() => inflight.delete(target));
  return work;
}

const refusedForSeed = new Map();
async function imageResponse(req, res, body, route) {
  const fields = await imageFields(req, body);
  const prompt = String(fields.prompt ?? "");
  const b = brandOf(prompt);
  const board = fields.background === "opaque";
  if (mode.images === "hold") return; // never answers: the engine's own timeout ends it
  if (mode.images === "slow") await new Promise((r) => setTimeout(r, mode.delayMs));
  if (
    mode.images === "refuse" ||
    (SEEDING && b?.failedLogoSlots && !board && (refusedForSeed.get(b.key) ?? 0) < b.failedLogoSlots)
  ) {
    if (mode.images !== "refuse") refusedForSeed.set(b.key, (refusedForSeed.get(b.key) ?? 0) + 1);
    stats.images.refused++;
    return json(res, 400, {
      error: {
        message: "Stand-in refusal (test data).",
        type: "image_generation_user_error",
        code: "moderation_blocked",
      },
    });
  }
  if (mode.images === "error")
    return json(res, 500, { error: { message: "stand-in server error", type: "server_error" } });

  let png;
  let usage = {
    input_tokens: 50,
    output_tokens: 1000,
    total_tokens: 1050,
    input_tokens_details: { text_tokens: 50, image_tokens: 0 },
  };
  if (b?.showcase) {
    const { file } = imageKey(fields, b);
    const target = path.join(SHOWCASE, b.key, file);
    if (existsSync(target)) {
      png = readFileSync(target);
      stats.images.cached++;
    } else if (REAL_IMAGES) {
      try {
        const real = await realImage(req, body, route, target);
        png = real.png;
        usage = real.usage ?? usage;
        stats.images.real++;
        console.log(`stand-in-ai: real image saved ${path.relative(here, target)}`);
      } catch (error) {
        console.error(`stand-in-ai: ${error.message}`);
        stats.images.refused++;
        return json(res, 400, {
          error: {
            message: "Showcase image unavailable (stand-in).",
            type: "image_generation_user_error",
            code: "moderation_blocked",
          },
        });
      }
    }
  }
  if (!png) {
    stats.images.placeholder++;
    png = board ? await placeholderBoard(next("board") - 1, b) : await placeholderLogo(next("logo") - 1, b?.name);
  }
  return json(res, 200, {
    created: Math.floor(Date.now() / 1000),
    background: fields.background,
    output_format: "png",
    quality: fields.quality,
    size: "1024x1024",
    data: [{ b64_json: png.toString("base64") }],
    usage,
  });
}

// Server ------------------------------------------------------------------------------------
const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json", "x-request-id": `req_audit_${++sequence}` });
  res.end(JSON.stringify(value));
};
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1"),
      route = url.pathname,
      body = await readBody(req);
    if (req.method === "GET" && route === "/__health") return json(res, 200, { ok: true });
    if (req.method === "GET" && route === "/__stats") return json(res, 200, { ...stats, realCalls, mode });
    if (route === "/__mode") {
      if (req.method === "POST") {
        const change = body.length ? JSON.parse(body.toString("utf8")) : {};
        for (const key of ["text", "images", "delayMs"]) if (change[key] !== undefined) mode[key] = change[key];
        console.log("stand-in-ai: mode", JSON.stringify(mode));
      }
      return json(res, 200, mode);
    }
    if (req.method === "POST" && route === "/v1/responses/input_tokens")
      return json(res, 200, { object: "response.input_tokens", input_tokens: 1200 });
    if (req.method === "POST" && route === "/v1/responses") {
      const request = JSON.parse(body.toString("utf8"));
      const entry = {
        id: `resp_audit${Date.now().toString(36)}${(++sequence).toString(36)}`,
        request,
        kind: classify(request),
        createdAt: Date.now(),
        mode: mode.text,
        delayMs: mode.delayMs,
        final: null,
      };
      responses.set(entry.id, entry);
      stats.responses[entry.kind] = (stats.responses[entry.kind] ?? 0) + 1;
      return json(res, 200, envelope(entry, "queued"));
    }
    const match = /^\/v1\/responses\/(resp_[A-Za-z0-9_-]+)(\/cancel)?$/u.exec(route);
    if (match) {
      const entry = responses.get(match[1]);
      if (!entry) return json(res, 404, { error: { message: "No such response", type: "invalid_request_error" } });
      if (match[2] && req.method === "POST") {
        if (!entry.final) {
          entry.final = envelope(entry, "cancelled");
          stats.cancelled++;
        }
        return json(res, 200, entry.final);
      }
      if (req.method === "GET") return json(res, 200, current(entry));
    }
    if (req.method === "POST" && (route === "/v1/images/generations" || route === "/v1/images/edits"))
      return await imageResponse(req, res, body, route);
    stats.unknown++;
    json(res, 404, {
      error: { message: `stand-in-ai: unsupported ${req.method} ${route}`, type: "invalid_request_error" },
    });
  } catch (error) {
    console.error("stand-in-ai:", error.message);
    if (error.status && error.json) return json(res, error.status, error.json);
    json(res, 500, { error: { message: "stand-in error", type: "server_error" } });
  }
});
server.listen(PORT, "127.0.0.1", () =>
  console.log(
    `stand-in-ai listening on http://127.0.0.1:${PORT} (seeding=${SEEDING}, realImages=${REAL_IMAGES ? `on, limit ${REAL_LIMIT}` : "off"})`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
