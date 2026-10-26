import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { bindNamingQuotePositions } from "../../src/server/ai/naming-brain/quote-binding";
import { validateNamingRoleOutput } from "../../src/server/ai/naming-brain/outputs";
import { buildNamingManagedRequest, createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { createNamingManagedProtocol } from "../../src/server/ai/naming-brain/protocol";
import { createNamingAgentRuntime } from "../../src/server/ai/naming-brain/transport";
import { createNamingBrainPolicy, createNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { namingTextHash } from "../../src/server/ai/naming-brain/identity";
import { createNamingCurationProjection, namingBriefSnapshotSchema, namingEvidenceQuoteSchema, namingProviderReceiptSchema, namingRoleOutputSchema, namingVerificationOutputSchema, namingVerificationSchema } from "../../src/domain/naming-brain";
import { creatorSet, curation, id, proposal, receipt, research, snapshot, source } from "../domain/naming-brain-fixtures";

const quote = "the goddess (= female god) of wisdom";
function output(text = quote, start = 265, end = 300) {
  return { role: "verifier" as const, findings: Array.from({ length: 4 }, (_, i) => ({ assignmentKey: "real", candidateKey: `pp-${i + 1}`, claimKey: "place",
    evidence: [{ sourceKey: "source-one", start, end, quote: text }], explanation: "Retained source supports this bounded fixture claim.", sourceKeys: ["source-one"],
    status: "supported" as const, supportedWording: "A bounded synthetic source claim.", supportsPrimaryApproach: true })) };
}
function retained(excerpt = "x".repeat(266) + quote + ".") { return { ...source(), excerpt, contentHash: namingTextHash(excerpt) }; }
function options(excerpt?: string, value = output()) {
  const saved = retained(excerpt), pack = namingRoleOutputSchema.parse({ ...research(), sources: [saved] });
  const created = namingRoleOutputSchema.parse(creatorSet(Array.from({ length: 4 }, (_, i) => ({ ...proposal(`Sample${i}`, `pp-${i + 1}`), claims: [{ claimKey: "place", statement: "A bounded synthetic source claim.", sourceKeys: [saved.sourceKey], requirement: "optional", status: "unverified" }] }))));
  const curated = namingRoleOutputSchema.parse(curation());
  if (created.output.role !== "creator") throw Error("fixture role");
  const brief = namingBriefSnapshotSchema.parse(snapshot());
  const request = createNamingRoleRequest({ runId: id(3), stageKey: "verification", providerCallKey: "part021.verification.verifier", policy: createNamingRolePolicy(createNamingBrainPolicy("fixture-selected-model"), "verification", "verifier"),
    dependencyArtifactIds: [created.artifactId, curated.artifactId, pack.artifactId], input: { role: "verifier", snapshot: brief,
      review: { version: 1, runId: id(3), snapshotHash: brief.snapshotHash, artifacts: [{ artifactKey: "a0", sourceArtifactId: created.artifactId, assignmentKey: "real", primaryApproach: "real_words", territoryId: "nature", constructionKey: "original" }],
        candidates: created.output.candidates.map(candidate => ({ artifactKey: "a0", candidateKey: candidate.candidateKey, value: candidate.value,
          additionalApproaches: candidate.additionalApproaches, rationale: candidate.rationale, caution: candidate.caution, claims: candidate.claims })), sources: [saved] }, curation: createNamingCurationProjection(curated) } });
  const observed = namingProviderReceiptSchema.parse({ ...receipt("verification", "verifier"), requestKey: request.requestKey, requestHash: request.requestHash, providerCallKey: request.providerCallKey, observedModel: request.policy.model, sessionLimitCents: request.policy.sessionLimitCents, artifactItemIds: ["retained-final-item"] });
  const text = JSON.stringify(value);
  return { request, receipt: observed, final: { itemId: "retained-final-item", text, itemContentHash: namingTextHash(text), value }, dependencies: [pack, created, curated], sources: [] };
}

describe("Source-backed Naming quote positions", () => {
  it("binds the four sanitized actual failing findings without changing raw provider evidence", () => {
    const input = options(), before = structuredClone(input), result = validateNamingRoleOutput(input);
    expect(result.output).toEqual(output(quote, 266, 302));
    expect(result).toMatchObject({ quoteBinding: { version: 1, itemId: input.final.itemId, itemContentHash: input.final.itemContentHash } });
    expect(input).toEqual(before);
    expect(validateNamingRoleOutput(input)).toEqual(result);
    expect(namingVerificationSchema.safeParse(result).success).toBe(true);
    expect(namingVerificationOutputSchema.safeParse(input.final.value).success).toBe(false);
    expect(namingEvidenceQuoteSchema.safeParse(input.final.value.findings[0]!.evidence[0]).success).toBe(false);
  });
  it("leaves valid historical output and artifact shape unchanged, including a precisely located repeated quote", () => {
    const excerpt = `${quote} / ${quote}`, input = options(excerpt, output(quote, 0, quote.length)), result = validateNamingRoleOutput(input);
    expect(result.output).toEqual(input.final.value);
    expect(result).not.toHaveProperty("quoteBinding");
  });
  it.each([0, 5])("preserves an exact repeated quote at %s when a different unique quote needs correction", start => {
    const excerpt = "same same unique", raw = output("same", start, start + 4);
    raw.findings[0]!.evidence.push({ sourceKey: "source-one", start: 0, end: 1, quote: "unique" });
    const bound = bindNamingQuotePositions(raw, [retained(excerpt)]);
    expect(bound.corrected).toBe(true);
    expect(bound.output.findings[0]!.evidence).toEqual([{ sourceKey: "source-one", start, end: start + 4, quote: "same" }, { sourceKey: "source-one", start: 10, end: 16, quote: "unique" }]);
    expect(raw.findings[0]!.evidence[1]!.start).toBe(0);
  });
  it("does not mistake a clamped slice end for an exact span", () => {
    const bound = bindNamingQuotePositions(output("unique", 0, 8000), [retained("unique")]);
    expect(bound.corrected).toBe(true);
    expect(bound.output).toEqual(output("unique", 0, 6));
  });
  it.each([
    ["astral prefix", "🧭🚀 exact source", "exact source", 5],
    ["astral quote", "prefix 🧭 signal", "🧭 signal", 7],
    ["combining marks", "a\u0301 exact source", "exact source", 3],
    ["CRLF", "a\r\nexact\r\nsource", "exact\r\nsource", 3],
    ["ZWJ", "👩‍🚀 exact source", "exact source", 6],
  ])("uses exact UTF-16 positions for %s", (_, excerpt, text, start) => {
    const actual = bindNamingQuotePositions(output(text, 0, 1), [retained(excerpt)]);
    expect(actual.output.findings.every(finding => finding.evidence[0]!.start === start && finding.evidence[0]!.end === Number(start) + String(text).length)).toBe(true);
    expect(actual.corrected).toBe(true);
  });
  it.each([
    ["missing", "unrelated text", quote], ["repeated", `${quote} / ${quote}`, quote], ["overlapping", "ababa", "aba"],
    ["normalization", "café", "cafe\u0301"], ["whitespace", "exact  source", "exact source"], ["punctuation", "exact—source", "exact-source"],
    ["unpaired surrogate", "prefix \ud83d suffix", "\ud83d"],
  ])("fails closed on %s instead of guessing or normalizing", (_, excerpt, text) => {
    expect(() => bindNamingQuotePositions(output(text, 0, 1), [retained(excerpt)])).toThrow();
  });
  it("does not drop one unverifiable finding from an otherwise bindable response", () => {
    const value = output(); value.findings[3]!.evidence[0]!.quote = "absent quote";
    expect(() => bindNamingQuotePositions(value, [retained()])).toThrow();
  });
  it.each([-1, 0.5, 8000])("rejects invalid declared starts %s before binding", start => {
    expect(() => bindNamingQuotePositions(output(quote, start, 8000), [retained()])).toThrow();
  });
  it("rejects unknown, unretrieved, colliding and tampered retained sources", () => {
    expect(() => bindNamingQuotePositions(output(), [])).toThrow();
    expect(() => bindNamingQuotePositions(output(), [{ ...retained(), evidenceStatus: "unretrieved", excerpt: null, contentHash: null } as never])).toThrow();
    expect(() => bindNamingQuotePositions(output(), [retained(), retained()])).toThrow();
    const input = options(); input.dependencies = input.dependencies.map(d => d.output.role === "researcher" ? { ...d, sources: [ { ...retained(), contentHash: "f".repeat(64) } ] } as typeof d : d);
    expect(() => validateNamingRoleOutput(input)).toThrow("source_evidence_missing");
  });
  it("retains raw item hash/value, claim reference, source closure and receipt checks", () => {
    const input = options();
    expect(() => validateNamingRoleOutput({ ...input, final: { ...input.final, itemContentHash: "f".repeat(64) } })).toThrow("provider_item_hash_mismatch");
    expect(() => validateNamingRoleOutput({ ...input, final: { ...input.final, value: output("forged") } })).toThrow("provider_item_content_mismatch");
    expect(() => validateNamingRoleOutput({ ...input, final: { ...input.final, itemId: "forged-final" } })).toThrow("provider_receipt_mismatch");
    expect(() => validateNamingRoleOutput({ ...input, dependencies: [] })).toThrow("dependency_mismatch");
    const value = output(); value.findings[0]!.candidateKey = "unknown"; const text = JSON.stringify(value);
    expect(() => validateNamingRoleOutput({ ...input, final: { ...input.final, value, text, itemContentHash: namingTextHash(text) } })).toThrow("verification_reference_mismatch");
  });
  it("reconstructs the binding from a known completed session with read-only SDK recovery", async () => {
    const input = options(), wire = buildNamingManagedRequest(input.request), observed = input.receipt;
    const methods: string[] = [], artifacts: unknown[] = [];
    const item = { id: input.final.itemId, type: "message", role: "assistant", phase: "final_answer", status: "completed", turn_id: observed.turnId,
      content: [{ type: "output_text", text: input.final.text }] };
    const turn = { id: observed.turnId, session_id: observed.sessionId, agent_id: observed.agentId, subagent_id: null, object: "agent.session.turn", status: "completed", error: null, usage: null, created_at: 1, started_at: 1, completed_at: 2 };
    const protocol = createNamingManagedProtocol({ apiKey: "synthetic-quote-recovery-only", fetch: async (incoming, init) => {
      const request = new Request(incoming, init), path = new URL(request.url).pathname; methods.push(request.method);
      expect(request.method).toBe("GET");
      if (path.endsWith("/events")) return new Response("", { headers: { "content-type": "text/event-stream" } });
      return Response.json(path.endsWith("/items") ? { data: [item], has_more: false } : path.endsWith(`/${observed.turnId}`) ? turn : {
        id: observed.sessionId, agent: { ...wire.agent, id: observed.agentId }, environment: wire.environment, metadata: wire.metadata,
        status: "idle", required_actions: [], spend_control: wire.spend_control,
      });
    } });
    const runtime = createNamingAgentRuntime({ model: input.request.policy.model, protocol, now: () => 1_000,
      persistence: { load: async () => ({ startedAt: new Date(1_000).toISOString(), authorizedAt: new Date(1_000).toISOString(), recoveryMode: "observe_only", observationDeadlineAt: new Date(20_000).toISOString(), request: input.request, dependencies: input.dependencies, providerItems: [], toolResults: [] }), saveToolResult: async () => { throw Error("unexpected_tool_dispatch"); } } });
    const outcome = await runtime.resumeStage(observed, { signal: new AbortController().signal, beforeDispatch: async () => { throw Error("unexpected_paid_dispatch"); }, onReceipt: async () => {}, onArtifact: async value => { artifacts.push(value); } });
    expect(outcome).toMatchObject({ status: "completed", output: { quoteBinding: { version: 1, itemId: input.final.itemId, itemContentHash: input.final.itemContentHash }, output: output(quote, 266, 302) } });
    expect(artifacts).toContainEqual({ providerCallKey: input.request.providerCallKey, sessionId: observed.sessionId, turnId: observed.turnId, itemId: input.final.itemId, item });
    expect(artifacts).toContainEqual({ kind: "provider_turn", providerCallKey: input.request.providerCallKey, sessionId: observed.sessionId, turnId: observed.turnId, turn });
    expect(methods.length).toBeGreaterThan(0); expect(new Set(methods)).toEqual(new Set(["GET"]));
    expect(item.content[0]!.text).toBe(input.final.text);
  });
});
