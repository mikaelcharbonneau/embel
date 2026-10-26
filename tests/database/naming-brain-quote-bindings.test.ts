import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createTestDatabase, type TestDatabase } from "./local-supabase";
import { installBrainFixture, saveBrainArtifact, seedBrainFixture, startBrainFixture } from "./naming-brain-fixture";

const filename = "20261026033000_naming_quote_bindings.sql";
const migration = await readFile(new URL(`../../supabase/migrations/${filename}`, import.meta.url), "utf8");
const signature = "fluid_private.naming_brain_call_completed(fluid_private.naming_brain_calls)";
const helper = "fluid_private.naming_brain_artifact_output_matches(text,jsonb,text)";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
type Metadata = { oid: number; proowner: number; prosecdef: boolean; provolatile: string; proconfig: string[]; proleakproof: boolean; acl: string | null };

function fixture(excerpt = "🪷e\u0301\r\nSynthetic exact factual reference. Final text.", quote = "Synthetic exact factual reference.") {
 const raw = { role: "verifier", findings: [{ assignmentKey: "language", candidateKey: "word", claimKey: "meaning", status: "supported", supportedWording: "Synthetic factual wording.", sourceKeys: ["source-one"],
  evidence: [{ sourceKey: "source-one", start: 0, end: 1, quote }], supportsPrimaryApproach: true, explanation: "Synthetic retained evidence supports this fixture." }] };
 const text = JSON.stringify(raw), output = structuredClone(raw), start = excerpt.indexOf(quote);
 output.findings[0]!.evidence[0] = { sourceKey: "source-one", start, end: start + quote.length, quote };
 const artifact = { output, sources: [{ sourceKey: "source-one", evidenceStatus: "retrieved", excerpt, contentHash: hash(excerpt) }], quoteBinding: { version: 1, itemId: "actual-final", itemContentHash: hash(text) } };
 return { raw, text, artifact };
}

describe("source-backed Naming quote SQL proof (disposable synthetic database)", () => {
 let db: TestDatabase, before: Metadata, predecessor: string, retainedBefore: unknown;
 async function retainedHistory() {
  return (await db.query(`select
   (select md5(jsonb_agg(to_jsonb(row) order by row.id)::text) from fluid_private.naming_brain_artifacts row) artifacts,
   (select md5(jsonb_agg(to_jsonb(row) order by row.id)::text) from fluid_private.naming_brain_receipts row) receipts,
   (select md5(jsonb_agg(to_jsonb(row) order by row.id)::text) from fluid_private.naming_brain_provider_records row) provider_records,
   (select md5(jsonb_agg(to_jsonb(row) order by row.call_key)::text) from fluid_private.naming_brain_calls row) calls`)).rows[0];
 }
 beforeAll(async () => {
  db = await createTestDatabase({ before: filename });
  await installBrainFixture(db);
  const project = await seedBrainFixture(db), job = await startBrainFixture(db, project);
  await saveBrainArtifact(db, job, "research", { role: "researcher", territories: [], facts: [], interpretations: [], uncertainties: [] }, { readiness: "partial", sources: [] });
  retainedBefore = await retainedHistory();
  before = (await db.query<Metadata>("select oid,proowner,prosecdef,provolatile,proconfig,proleakproof,proacl::text acl from pg_proc where oid=$1::regprocedure", [signature])).rows[0]!;
  predecessor = (await db.query<{ definition: string }>("select pg_get_functiondef($1::regprocedure) definition", [signature])).rows[0]!.definition;
  await db.exec(migration);
 }, 30_000);
 afterAll(async () => { await db?.close(); });
 async function matches(text: string, artifact: unknown, itemId = "actual-final") {
  return (await db.query<{ matches: boolean }>("select fluid_private.naming_brain_artifact_output_matches($1,$2::jsonb,$3) matches", [text, JSON.stringify(artifact), itemId])).rows[0]!.matches;
 }

 it("changes only the guarded comparison and preserves the completion function owner, ACL and execution metadata", async () => {
  const after = (await db.query<Metadata>("select oid,proowner,prosecdef,provolatile,proconfig,proleakproof,proacl::text acl from pg_proc where oid=$1::regprocedure", [signature])).rows[0]!;
  expect(after).toEqual(before);
  const definition = (await db.query<{ definition: string }>("select pg_get_functiondef($1::regprocedure) definition", [signature])).rows[0]!.definition;
  expect(definition).toBe(predecessor.replace("fluid_private.naming_brain_json_matches(final.text,a.artifact->'output')", "fluid_private.naming_brain_artifact_output_matches(final.text,a.artifact,pr.payload->>'itemId')"));
  const permissions = (await db.query<{ allowed: boolean }>("select has_function_privilege(role,$1,'execute') allowed from unnest(array['anon','authenticated','service_role']) role", [helper])).rows;
  expect(permissions).toEqual([{ allowed: false }, { allowed: false }, { allowed: false }]);
  expect(await retainedHistory()).toEqual(retainedBefore);
  expect((await db.query<{ completed: boolean }>("select fluid_private.naming_brain_call_completed(c) completed from fluid_private.naming_brain_calls c")).rows).toEqual([{ completed: true }]);
 });

 it("rejects a changed predecessor before replacing completion logic", async () => {
  await db.exec("begin");
  try {
   await db.exec(predecessor.replace("select exists(select 1", "select /* unexpected predecessor */ exists(select 1"));
   const patch = migration.slice(migration.indexOf("do $patch$"), migration.lastIndexOf("commit;"));
   await expect(db.exec(patch)).rejects.toThrow("unexpected_naming_quote_binding_predecessor");
  } finally { await db.exec("rollback"); }
 });

 it("keeps exact legacy equality, including repeated passages and non-verifier roles", async () => {
  for (const output of [{ role: "creator", candidates: [] }, fixture("same same", "same").raw]) {
   expect(await matches(JSON.stringify(output), { output })).toBe(true);
   expect(await matches(JSON.stringify(output), { output: { ...output, extra: true } })).toBe(false);
  }
  expect(await matches("{invalid", { output: {} })).toBe(false);
 });

 it.each([
  ["🪷e\u0301\r\nSynthetic exact factual reference. Final text.", "Synthetic exact factual reference."],
  ["Before 🐈 cat and after.", "🐈 cat"],
  ["e\u0301 is decomposed; café is composed.\r\nEnd.", "café is composed.\r\n"],
  ["Unique prefix and exact ending.", "exact ending."],
 ])("uses exact UTF-16 offsets for %j", async (excerpt, quote) => {
  const { text, artifact } = fixture(excerpt, quote);
  expect(await matches(text, artifact)).toBe(true);
  const bad = structuredClone(artifact);
  bad.output.findings[0]!.evidence[0]!.start++;
  expect(await matches(text, bad)).toBe(false);
 });

 it("reconstructs every evidence span while preserving findings, source keys, text and ordering", async () => {
  const { raw, artifact } = fixture();
  const quote = "Final text.", start = artifact.sources[0]!.excerpt.indexOf(quote);
  raw.findings[0]!.evidence.push({ sourceKey: "source-one", start: 1, end: 2, quote });
  artifact.output.findings[0]!.evidence.push({ sourceKey: "source-one", start, end: start + quote.length, quote });
  const text = JSON.stringify(raw); artifact.quoteBinding.itemContentHash = hash(text);
  expect(await matches(text, artifact)).toBe(true);
  for (const field of ["supportedWording", "explanation", "claimKey"] as const) {
   const changed = structuredClone(artifact); changed.output.findings[0]![field] = "changed";
   expect(await matches(text, changed)).toBe(false);
  }
  const reordered = structuredClone(artifact); reordered.output.findings[0]!.evidence.reverse();
  expect(await matches(text, reordered)).toBe(false);
 });

 it.each(["", "🐈 ", "🪷e\u0301\r\n"].flatMap(prefix => [0, 1].map(occurrence => ({ prefix, occurrence }))))("preserves exact repeated span $occurrence after prefix $prefix while repairing a unique sibling", async ({ prefix, occurrence }) => {
  const excerpt = `${prefix}same same unique`, { raw, artifact } = fixture(excerpt, "unique");
  const start = prefix.length + occurrence * 5, repeated = { sourceKey: "source-one", start, end: start + 4, quote: "same" };
  raw.findings[0]!.evidence.unshift(repeated);
  artifact.output.findings[0]!.evidence.unshift({ ...repeated });
  const text = JSON.stringify(raw); artifact.quoteBinding.itemContentHash = hash(text);
  expect(await matches(text, artifact)).toBe(true);
  const changed = structuredClone(artifact), otherStart = prefix.length + (1 - occurrence) * 5;
  changed.output.findings[0]!.evidence[0] = { ...repeated, start: otherStart, end: otherStart + 4 };
  expect(await matches(text, changed)).toBe(false);
 });

 it("rejects inaccurate ambiguous spans even when a unique sibling can be repaired", async () => {
  const { raw, artifact } = fixture("same same unique", "unique");
  raw.findings[0]!.evidence.unshift({ sourceKey: "source-one", start: 1, end: 5, quote: "same" });
  artifact.output.findings[0]!.evidence.unshift({ sourceKey: "source-one", start: 0, end: 4, quote: "same" });
  const text = JSON.stringify(raw); artifact.quoteBinding.itemContentHash = hash(text);
  expect(await matches(text, artifact)).toBe(false);
 });

 it.each(["decimal", "exponent"] as const)("accepts integral raw JSON offset lexemes in %s notation", async notation => {
  const { raw, artifact } = fixture(" same same unique", "unique");
  const exact = { sourceKey: "source-one", start: 1, end: 5, quote: "same" };
  raw.findings[0]!.evidence.unshift(exact);
  artifact.output.findings[0]!.evidence.unshift({ ...exact });
  // JSON.stringify canonicalizes these numeric forms, so retain actual provider
  // text containing both exact and inaccurate integral offset lexemes.
  const text = JSON.stringify(raw).replace(/"(start|end)":(\d+)/g, (_match, key: string, value: string) => `"${key}":${value}${notation === "decimal" ? ".0" : "e0"}`);
  artifact.quoteBinding.itemContentHash = hash(text);
  expect(await matches(text, artifact)).toBe(true);
 });

 it("repairs an oversized end instead of treating a clamped substring as exact", async () => {
  const { raw, artifact } = fixture("unique", "unique");
  raw.findings[0]!.evidence[0]!.end = 8000;
  const text = JSON.stringify(raw); artifact.quoteBinding.itemContentHash = hash(text);
  expect(await matches(text, artifact)).toBe(true);
  const clamped = structuredClone(artifact); clamped.output = raw;
  expect(await matches(text, clamped)).toBe(false);
 });

 it.each([{ start: 1, end: 3 }, { start: 0, end: 1 }])("uniquely repairs a split-surrogate hint %j", async hint => {
  const { raw, artifact } = fixture("🐈 unique", "🐈");
  Object.assign(raw.findings[0]!.evidence[0]!, hint);
  const text = JSON.stringify(raw); artifact.quoteBinding.itemContentHash = hash(text);
  expect(await matches(text, artifact)).toBe(true);
 });

 it("keeps source and quote limits in UTF-16 units at their exact boundaries", async () => {
  const edge = fixture(`${"a".repeat(7999)}Z`, "Z");
  expect(await matches(edge.text, edge.artifact)).toBe(true);
  const tooLong = fixture(`${"a".repeat(8000)}Z`, "Z");
  expect(await matches(tooLong.text, tooLong.artifact)).toBe(false);
  const quote = "🐈".repeat(1000), maximumQuote = fixture(`Prefix ${quote}`, quote);
  expect(await matches(maximumQuote.text, maximumQuote.artifact)).toBe(true);
  const oversizedQuote = fixture(`Prefix ${quote}Z`, `${quote}Z`);
  expect(await matches(oversizedQuote.text, oversizedQuote.artifact)).toBe(false);
 });

 it.each([
  ["same same", "same"], ["aaaa", "aaa"], ["one passage", "missing"], ["café", "cafe\u0301"], ["word—word", "word-word"], ["two  spaces", "two spaces"],
 ])("rejects absent or ambiguous exact text: %j / %j", async (excerpt, quote) => {
  const { text, artifact } = fixture(excerpt, quote);
  expect(await matches(text, artifact)).toBe(false);
 });

 it("rejects forged, unnecessary, unknown, null and malformed witnesses", async () => {
  const { text, artifact } = fixture();
  for (const witness of [null, [], {}, { ...artifact.quoteBinding, version: 2 }, { ...artifact.quoteBinding, itemId: "invented-final" },
   { ...artifact.quoteBinding, itemContentHash: "0".repeat(64) }, { ...artifact.quoteBinding, itemContentHash: 1 }, { ...artifact.quoteBinding, extra: true }]) {
   expect(await matches(text, { ...artifact, quoteBinding: witness })).toBe(false);
  }
  expect(await matches(text, artifact, "other-final")).toBe(false);
  const identical = fixture(); identical.artifact.output = identical.raw;
  expect(await matches(identical.text, identical.artifact)).toBe(false);
  const creator = { role: "creator", candidates: [] }, creatorText = JSON.stringify(creator);
  expect(await matches(creatorText, { ...artifact, output: creator, quoteBinding: { ...artifact.quoteBinding, itemContentHash: hash(creatorText) } })).toBe(false);
  for (const invalid of ["{bad json", "null", "[]", '{"role":"verifier","findings":null}', '{"role":"verifier","findings":{}}']) {
   expect(await matches(invalid, { ...artifact, quoteBinding: { ...artifact.quoteBinding, itemContentHash: hash(invalid) } })).toBe(false);
  }
 });

 it("rejects forged or malformed retained sources, collisions and source references", async () => {
  const { text, artifact } = fixture();
  for (const patch of [{ contentHash: "0".repeat(64) }, { contentHash: null }, { excerpt: 42 }, { excerpt: "changed" }, { evidenceStatus: "unretrieved" }, { sourceKey: "unknown" }]) {
   const changed = { ...artifact, sources: [{ ...artifact.sources[0], ...patch }] };
   expect(await matches(text, changed)).toBe(false);
  }
  for (const sources of [null, {}, [], [artifact.sources[0], artifact.sources[0]]]) expect(await matches(text, { ...artifact, sources })).toBe(false);
  for (const sourceKeys of [["source-one", "source-one"], ["unknown"], [42], [], null]) {
   const raw = structuredClone(fixture().raw) as Record<string, unknown>;
   (raw.findings as Record<string, unknown>[])[0]!.sourceKeys = sourceKeys;
   const altered = JSON.stringify(raw);
   expect(await matches(altered, { ...artifact, quoteBinding: { ...artifact.quoteBinding, itemContentHash: hash(altered) } })).toBe(false);
  }
 });

 it("fails closed for malformed evidence, noninteger or out-of-range hints and unsupported factual credit", async () => {
  const { artifact } = fixture();
  for (const patch of [{ start: -1 }, { start: 8000 }, { end: 8001 }, { end: 0 }, { start: 0.5 }, { start: "0" }, { start: 2, end: 1 },
   { quote: "" }, { quote: null }, { quote: 42 }, { sourceKey: "unknown" }, { extra: true }]) {
   const raw = structuredClone(fixture().raw), evidence = { ...raw.findings[0]!.evidence[0], ...patch };
   const output = { ...raw, findings: [{ ...raw.findings[0], evidence: [evidence] }] }, text = JSON.stringify(output);
   expect(await matches(text, { ...artifact, quoteBinding: { ...artifact.quoteBinding, itemContentHash: hash(text) } })).toBe(false);
  }
  for (const patch of [{ evidence: null }, { evidence: {} }, { evidence: [null] }, { status: "unresolved" }, { supportedWording: null }, { supportsPrimaryApproach: "true" }]) {
   const raw = fixture().raw, text = JSON.stringify({ ...raw, findings: [{ ...raw.findings[0], ...patch }] });
   expect(await matches(text, { ...artifact, quoteBinding: { ...artifact.quoteBinding, itemContentHash: hash(text) } })).toBe(false);
  }
 });

 it.each(["valid", "absent", "forged hash", "forged item"] as const)("requires valid raw-item proof for restricted worker completion: %s witness", async bindingMode => {
  const project = await seedBrainFixture(db), job = await startBrainFixture(db, project);
  const research = await saveBrainArtifact(db, job, "research", { role: "researcher", territories: [], facts: [], interpretations: [], uncertainties: [] }, { readiness: "sourced", sources: [] });
  await saveBrainArtifact(db, job, "direction", { role: "director", round: "initial", assignments: [], feedbackHypotheses: [] });
  await saveBrainArtifact(db, job, "creation", { role: "creator", assignmentKey: "real", candidates: [] }, { candidateIds: [] });
  await saveBrainArtifact(db, job, "curation", { role: "curator", annotations: [], gaps: [] });
  const sources = (research as unknown as { sources: { sourceKey: string; excerpt: string; providerItemId: string; contentHash: string }[] }).sources, source = sources[0]!;
  const raw = fixture(source.excerpt, source.excerpt).raw;
  raw.findings[0]!.sourceKeys = [source.sourceKey]; raw.findings[0]!.evidence[0]!.sourceKey = source.sourceKey;
  const canonical = structuredClone(raw); canonical.findings[0]!.evidence[0] = { sourceKey: source.sourceKey, start: 0, end: source.excerpt.length, quote: source.excerpt };
  const text = JSON.stringify(raw), binding = { version: 1, itemId: "fixture-final-verification", itemContentHash: hash(text) };
  if (bindingMode === "forged hash") binding.itemContentHash = "0".repeat(64);
  if (bindingMode === "forged item") binding.itemId = "invented-final";
  const artifact = await saveBrainArtifact(db, job, "verification", raw, { output: canonical, ...(bindingMode === "absent" ? {} : { quoteBinding: binding }), sources,
   sourceDependencies: [{ artifactId: research.artifactId, runId: research.runId, snapshotHash: research.snapshotHash, providerReceipt: research.providerReceipt,
    sources: sources.map(row => ({ sourceKey: row.sourceKey, providerItemId: row.providerItemId, contentHash: row.contentHash })) }] });
  expect((await db.query<{ completed: boolean }>("select fluid_private.naming_brain_call_completed(c) completed from fluid_private.naming_brain_calls c where run_id=$1 and stage_key='verification'", [job.input.runId])).rows).toEqual([{ completed: bindingMode === "valid" }]);
  expect((await db.query<{ state: string }>("select state from public.job_steps where job_id=$1 and step_key='verification'", [job.id])).rows[0]!.state).toBe(bindingMode === "valid" ? "succeeded" : "ambiguous");
  expect((await db.query<{ text: string }>("select payload#>>'{item,content,0,text}' text from fluid_private.naming_brain_provider_records where run_id=$1 and kind='provider_item' and stage_key='verification'", [job.input.runId])).rows[0]!.text).toBe(text);
  expect((await db.query<{ artifact: unknown }>("select artifact from fluid_private.naming_brain_artifacts where id=$1", [artifact.artifactId])).rows[0]!.artifact).toEqual(artifact);
 });
});
