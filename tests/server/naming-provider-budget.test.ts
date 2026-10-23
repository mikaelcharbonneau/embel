import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { namingBriefSnapshotSchema, namingRolePolicySchema } from "../../src/domain/naming-brain";
import { id, snapshot } from "../domain/naming-brain-fixtures";
import { createNamingBrainPolicy, createBudgetedProgressiveNamingRolePolicy, createProgressiveNamingRolePolicy } from "../../src/server/ai/naming-brain/policy";
import { buildNamingManagedRequest, createNamingRoleRequest } from "../../src/server/ai/naming-brain/prompts";
import { createNamingManagedProtocol } from "../../src/server/ai/naming-brain/protocol";

function request(capped: boolean) {
 const policy = createNamingBrainPolicy("gpt-6-luna");
 return createNamingRoleRequest({ runId: id(3), stageKey: "creation", providerCallKey: "context.research.researcher", dependencyArtifactIds: [],
  policy: capped ? createBudgetedProgressiveNamingRolePolicy(policy, "researcher") : createProgressiveNamingRolePolicy(policy, "researcher", undefined, undefined, true, 3),
  input: { role: "researcher", snapshot: namingBriefSnapshotSchema.parse(snapshot()) } });
}
describe("future progressive provider spending guard", () => {
 it("freezes an explicit provider cap without changing historical wire requests", () => {
  const capped = request(true), historical = request(false);
  expect(buildNamingManagedRequest(capped)).toMatchObject({ spend_control: { limit: 25 }, metadata: { embel_provider_spend_cap_cents: "25" } });
  expect(buildNamingManagedRequest(historical)).not.toHaveProperty("spend_control");
  expect(buildNamingManagedRequest(historical).metadata).not.toHaveProperty("embel_provider_spend_cap_cents");
  expect(capped.requestHash).not.toBe(historical.requestHash);
  expect(() => namingRolePolicySchema.parse({ ...capped.policy, providerSpendCapCents: 26 })).toThrow();
 });
 it("sends the cap once and never falls back to unlimited if the provider rejects it", async () => {
  const bodies: unknown[] = [];
  const protocol = createNamingManagedProtocol({ apiKey: "synthetic-only", localPrototype: true, onDiagnostic: () => {}, fetch: async (input, init) => {
   bodies.push(await new Request(input, init).json());
   return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "unsupported_parameter", param: "spend_control", message: "Synthetic unsupported cap" } }), { status: 400 });
  } });
  await expect(protocol.createSession(buildNamingManagedRequest(request(true)), new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected", diagnostic: { parameter: "spend_control" } });
  expect(bodies).toHaveLength(1); expect(bodies[0]).toMatchObject({ spend_control: { limit: 25 } });
 });
 it("refuses missing, mismatched, nonnumeric and out-of-range wire caps before HTTP", async () => {
  const fetcher = vi.fn();
  const protocol = createNamingManagedProtocol({ apiKey: "synthetic-only", localPrototype: true, fetch: fetcher });
  for (const cap of [undefined, null, 0, 26, 151, 1.5, Number.NaN]) {
   const body = { ...buildNamingManagedRequest(request(true)), spend_control: cap === undefined ? undefined : cap === null ? null : { limit: cap } };
   await expect(protocol.createSession(body, new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
  }
  expect(fetcher).not.toHaveBeenCalled();
 });
});
