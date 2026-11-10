#!/usr/bin/env node
// A local stand-in for the OpenAI endpoints the generation engine calls, for the
// browser journey test (tests/journey). It answers every engine kind with valid,
// schema-correct output so each step of the journey completes, for free:
// - POST /v1/responses/input_tokens            token count
// - POST /v1/responses                         background create (queued)
// - GET  /v1/responses/:id                     in_progress, then completed
// - POST /v1/responses/:id/cancel              cancelled
// - POST /v1/images/generations | /edits       one 1024 x 1024 PNG
// - GET  /__health, GET /__stats               readiness and what was served
// The engine reaches it only through EMBEL_OPENAI_BASE_URL, which production ignores
// (src/server/engine/provider-origin.ts). Listens on loopback only.
import { createServer } from "node:http";
import sharp from "sharp";

const PORT = Number(process.env.FAKE_OPENAI_PORT ?? "3176");
/** How long a background response stays in progress, so the app's polling is exercised. */
const WORK_MS = Number(process.env.FAKE_OPENAI_WORK_MS ?? "1500");
const responses = new Map();
const stats = { responses: {}, images: { logo: 0, board: 0 }, cancelled: 0, unknown: 0 };
let sequence = 0;
const count = key => { stats.responses[key] = (stats.responses[key] ?? 0) + 1; };

// Names ------------------------------------------------------------------------------
const CONSONANTS = "bdfgklmnprstvz", VOWELS = "aeiou";
let nameCounter = 0;
/** A pronounceable lowercase word, unique for the life of the process. */
function word() {
  let n = nameCounter++ + 37, text = "";
  for (let i = 0; i < 3; i++) { text += CONSONANTS[n % CONSONANTS.length] + VOWELS[Math.floor(n / CONSONANTS.length) % VOWELS.length]; n = Math.floor(n / (CONSONANTS.length * VOWELS.length)) + i + 3; }
  return text + CONSONANTS[nameCounter % CONSONANTS.length];
}
const capital = text => text[0].toUpperCase() + text.slice(1);
/** One candidate that passes the Naming construction check of its approach (src/domain/naming-brainstorm.ts). */
function candidate(approach) {
  const a = word(), b = word(), c = word();
  const base = { rationale: `Built from ${a} to suggest warm, everyday craft.`, primaryApproach: approach };
  switch (approach) {
    case "invented": return { ...base, value: capital(a), construction: [] };
    case "real_words": return { ...base, value: capital(a), construction: [a] };
    case "modified": return { ...base, value: capital(a) + "a", construction: [a] };
    case "blends": return { ...base, value: capital(a.slice(0, 3) + b.slice(2)), construction: [a, b] };
    case "compounds": return { ...base, value: capital(a) + b, construction: [a, b] };
    case "phrases": return { ...base, value: `${capital(a)} ${capital(b)}`, construction: [a, b] };
    case "initials": return { ...base, value: (a[0] + b[0] + c[0] + a[1]).toUpperCase(), construction: [a, b, c, a.slice(1)] };
    default: return { ...base, value: capital(a), construction: [`${a} (Latin)`] };
  }
}
function namingReply(request) {
  const paragraphs = String(request.input).split("\n\n");
  const plan = JSON.parse(paragraphs.at(-1)).approachPlan;
  return { candidates: plan.flatMap(slot => Array.from({ length: slot.request }, () => candidate(slot.approach))) };
}

// Strategy ---------------------------------------------------------------------------
const COMPETITORS = [
  { name: "Northloaf Bakery", url: "https://northloaf.example.com/" },
  { name: "Crumb & Co", url: "https://crumb-and-co.example.com/" },
  { name: "Office Oven", url: "https://office-oven.example.com/" },
];
const option = (index, label, description, payload) => ({
  label, description, recommended: index === 0, recommendationReason: index === 0 ? "It fits the offering and audience most closely." : null, payload,
});
function strategyReply(request) {
  const content = JSON.parse(request.input[0].content);
  const turn = content.currentTurn;
  if (!turn) throw new Error("Only guided Strategy requests are supported");
  const common = { targetStage: null, selection: null };
  if (turn.purpose === "message") return { ...common, kind: "answer", message: "Thanks, that helps. Choose an option when you are ready.", question: null, options: [] };
  const choices = (message, question, options) => ({ ...common, kind: "choices", message, question, options });
  switch (turn.stage) {
    case "competitors": return choices("Here are competitors research found.", "Which competitors should we keep in mind?",
      COMPETITORS.map((item, index) => option(index, item.name, `${item.name} sells fresh bread to offices.`,
        { name: item.name, relevance: `${item.name} delivers baked goods to workplaces.`, url: item.url, sourceUrls: [item.url] })));
    case "audience": return choices("These audiences look promising.", "Who should the brand speak to first?",
      ["Office managers", "Startup founders", "Coworking hosts"].map((label, index) => option(index, label, `${label} who order food for teams.`,
        { label, needs: ["Reliable weekly delivery", "Fresh food people enjoy"], reason: `${label} choose what the team eats.` })));
    case "positioning": return choices("Three ways to stand apart.", "Which positioning fits best?",
      ["Fresh every Monday", "The neighborhood baker at work", "Bread without the errand"].map((angle, index) => option(index, angle, `Lead with: ${angle}.`,
        { angle, statement: `For busy offices, we are ${angle.toLowerCase()}.`, why: "It answers the audience's main need.", leads: ["Freshness", "Reliability"] })));
    case "personality": return choices("Three personality directions.", "Which personality feels right?",
      ["Warm and dependable", "Lively and bold", "Refined and calm"].map((label, index) => option(index, label, `${label}, in plain words.`,
        { profile: { sincerity: 80 - index * 20, excitement: 40 + index * 20, competence: 70, sophistication: 30 + index * 25, ruggedness: 20 },
          traits: label.split(" and "), toneExample: "Fresh bread is on its way.", expression: "Short, friendly sentences." })));
    case "slogan": return choices("A few slogan ideas.", "Which slogan do you like?",
      ["Fresh bread, every week", "Your office, well fed", "Baked for your Monday"].map((slogan, index) => option(index, slogan, "Emphasizes freshness.", { slogan })));
    default: throw new Error(`Unknown Strategy stage ${turn.stage}`);
  }
}

// Creative directions ---------------------------------------------------------------------
const PALETTES = [["#1F4E5F", "#E07A5F"], ["#3D405B", "#81B29A"], ["#5C3D2E", "#F2CC8F"]];
const GRAPHICS = ["rounded_shapes", "fine_lines", "bold_blocks"], LAYOUTS = ["editorial", "centered", "split"];
function identityReply(request) {
  const text = String(request.input[0].content);
  const data = JSON.parse(text.slice(text.indexOf("{")));
  const n = data.ordinal, fonts = data.supportedTypography;
  const font = fonts[(n - 1) % fonts.length];
  const weight = Math.min(font.maxWeight, Math.max(font.minWeight, 400));
  const [primary, accent] = PALETTES[(n - 1) % PALETTES.length];
  const note = { direction: `Direction ${n}: the chosen logo with a calm supporting system`, usageNotes: "Keep clear space around the logo." };
  return {
    components: {
      logo: note,
      colors: { swatches: [{ key: "primary", name: "Primary", hex: primary }, { key: "accent", name: "Accent", hex: accent },
        { key: "background", name: "Background", hex: "#FFFFFF" }, { key: "text", name: "Text", hex: "#111111" }], usageNotes: `Palette ${n}` },
      typography: { styles: [{ key: "body", role: "Body", family: font.family, weight, style: "normal" }], usageNotes: "Specification only." },
      graphics: { ...note, direction: `Graphics ${n}` }, imagery: { ...note, direction: `Imagery ${n}` }, composition: { ...note, direction: `Composition ${n}` },
    },
    boardPrompt: `Board ${n} with the chosen logo, palette and example uses.`,
    applicationDesign: { version: 1, graphic: GRAPHICS[(n - 1) % 3], layout: LAYOUTS[(n - 1) % 3],
      paletteRoles: { primary: "primary", accent: "accent", background: "background", text: "text" }, headingStyleKey: "body", bodyStyleKey: "body" },
  };
}

// Responses ---------------------------------------------------------------------------
function classify(request) {
  const format = request.text?.format;
  if (format?.type === "json_schema" && format.name === "naming_generation_v2") return "naming";
  if (format?.type === "json_schema" && String(format.name).startsWith("strategy_")) return format.name.replace("_", ".");
  if (format?.type === "json_object" && String(request.input?.[0]?.content ?? "").includes("supportedTypography")) return "identity.spec";
  return "other";
}
function completedBody(entry) {
  const { request, kind } = entry;
  const value = kind === "naming" ? namingReply(request) : kind === "identity.spec" ? identityReply(request)
    : kind.startsWith("strategy.") ? strategyReply(request) : { note: "Clean geometric line work." };
  const output = [];
  if (kind === "strategy.competitors") {
    output.push({ type: "web_search_call", id: `ws_${entry.id}`, status: "completed",
      action: { type: "search", query: "office bread delivery", sources: COMPETITORS.map(item => ({ type: "url", url: item.url, title: item.name })) } });
  }
  output.push({ type: "message", id: `msg_${entry.id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] });
  return { ...envelope(entry, "completed"), output, usage: { input_tokens: 1200, output_tokens: 400, total_tokens: 1600,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
}
function envelope(entry, status) {
  return { id: entry.id, object: "response", created_at: Math.floor(entry.createdAt / 1000), status, background: true, model: entry.request.model,
    service_tier: "default", error: null, incomplete_details: null, output: [], usage: null };
}
function current(entry) {
  if (entry.final) return entry.final;
  if (Date.now() - entry.createdAt < WORK_MS) return envelope(entry, "in_progress");
  try { entry.final = completedBody(entry); }
  catch (error) {
    console.error(`fake-openai: ${entry.kind} failed: ${error.message}`);
    entry.final = { ...envelope(entry, "failed"), error: { code: "server_error", message: "fake provider could not answer" } };
  }
  return entry.final;
}

// Images ------------------------------------------------------------------------------
/** A black mark on a transparent square: it passes the Logo raster checks (1024 x 1024, no color). */
async function logoPng(n) {
  const r = 160 + (n % 6) * 30, x = 512 + ((n % 3) - 1) * 60;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><circle cx="${x}" cy="440" r="${r}" fill="#000"/>`
    + `<rect x="${300 + (n % 4) * 20}" y="760" width="${424 - (n % 4) * 40}" height="${60 + (n % 5) * 10}" fill="#000"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
/** An opaque full-color board. */
async function boardPng(n) {
  const [primary, accent] = PALETTES[n % PALETTES.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#FFFFFF"/>`
    + `<rect x="64" y="64" width="560" height="560" fill="${primary}"/><circle cx="800" cy="300" r="150" fill="${accent}"/>`
    + `<rect x="64" y="700" width="896" height="80" fill="#111111"/><rect x="64" y="820" width="600" height="40" fill="${accent}"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
async function imageFields(request, body) {
  if (String(request.headers["content-type"] ?? "").startsWith("application/json")) return JSON.parse(body.toString("utf8"));
  const form = await new Response(body, { headers: { "content-type": request.headers["content-type"] } }).formData();
  return Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === "string"));
}

// Server ------------------------------------------------------------------------------
const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json", "x-request-id": `req_fake_${++sequence}` }); res.end(JSON.stringify(value)); };
async function readBody(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); }

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1"), path = url.pathname, body = await readBody(req);
    if (req.method === "GET" && path === "/__health") return json(res, 200, { ok: true });
    if (req.method === "GET" && path === "/__stats") return json(res, 200, stats);
    if (req.method === "POST" && path === "/v1/responses/input_tokens") return json(res, 200, { object: "response.input_tokens", input_tokens: 1200 });
    if (req.method === "POST" && path === "/v1/responses") {
      const request = JSON.parse(body.toString("utf8"));
      const entry = { id: `resp_fake${Date.now().toString(36)}${(++sequence).toString(36)}`, request, kind: classify(request), createdAt: Date.now(), final: null };
      responses.set(entry.id, entry); count(entry.kind);
      return json(res, 200, envelope(entry, "queued"));
    }
    const match = /^\/v1\/responses\/(resp_[A-Za-z0-9_-]+)(\/cancel)?$/u.exec(path);
    if (match) {
      const entry = responses.get(match[1]);
      if (!entry) return json(res, 404, { error: { message: "No such response", type: "invalid_request_error" } });
      if (match[2] && req.method === "POST") {
        if (!entry.final) { entry.final = envelope(entry, "cancelled"); stats.cancelled++; }
        return json(res, 200, entry.final);
      }
      if (req.method === "GET") return json(res, 200, current(entry));
    }
    if (req.method === "POST" && (path === "/v1/images/generations" || path === "/v1/images/edits")) {
      const fields = await imageFields(req, body);
      const board = fields.background === "opaque";
      const n = board ? stats.images.board++ : stats.images.logo++;
      const png = await (board ? boardPng(n) : logoPng(n));
      return json(res, 200, { created: Math.floor(Date.now() / 1000), background: fields.background, output_format: "png", quality: fields.quality, size: "1024x1024",
        data: [{ b64_json: png.toString("base64") }],
        usage: { input_tokens: 50, output_tokens: 1000, total_tokens: 1050, input_tokens_details: { text_tokens: 50, image_tokens: 0 } } });
    }
    stats.unknown++;
    json(res, 404, { error: { message: `fake-openai: unsupported ${req.method} ${path}`, type: "invalid_request_error" } });
  } catch (error) {
    console.error("fake-openai:", error);
    json(res, 500, { error: { message: "fake provider error", type: "server_error" } });
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`fake-openai listening on http://127.0.0.1:${PORT}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
