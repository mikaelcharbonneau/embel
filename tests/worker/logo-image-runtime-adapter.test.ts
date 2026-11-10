import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { IdentityAssetStore } from "../../src/server/data/identity-asset-store";
import type { LogoWorkerConnection } from "../../src/server/data/logo-jobs";
import { CAPPED_LOGO_IMAGE_MODEL } from "../../src/domain/providers";
import { OpenAIImageTransportError } from "../../src/server/ai/openai-image-transport";
import { SUNBURST_STANDARD_IMAGE_PRICING } from "../../src/server/ai/openai-image-pricing";
import { createLogoImageRuntimeAdapter, type LogoImageRuntimeAdapterInput } from "../../worker/logo-image-runtime-adapter";
import { syntheticLogoJob, syntheticResolvedLogoConcept, syntheticResolvedLogoRefinement, syntheticLogoReferences, logoFixtureId as id } from "../fixtures/logo-creation";

function fixture(operation: "identity.logo_concept" | "identity.logo_refine" = "identity.logo_concept") {
  const resolved = structuredClone(operation === "identity.logo_concept" ? syntheticResolvedLogoConcept() : syntheticResolvedLogoRefinement());
  const job = syntheticLogoJob(resolved.input);
  const query = vi.fn(async (sql: string, parameters?: unknown[]) => { void sql; void parameters; return { rows: [{ value: resolved }] }; });
  const denied = vi.fn(async (): Promise<never> => { throw Error("No synthetic byte I/O expected"); });
  const assets: IdentityAssetStore = { stageOwnedAsset: denied, publishOwnedUpload: denied, readOwnedAsset: denied, readLeasedAsset: denied, publishLeasedAsset: denied };
  const assertAvailable = vi.fn(async () => {});
  const generate = vi.fn(async (): Promise<never> => { throw Error("No synthetic image request expected"); });
  const options: LogoImageRuntimeAdapterInput = { ownerId: job.ownerId, capability: { operation, policyIdentity: "c".repeat(64),
    handlerVersion: "logo-image-v1", provider: "openai", model: CAPPED_LOGO_IMAGE_MODEL, engine: null, maxCostMicrousd: 2000 },
    image: { apiKey: "synthetic-never-display", model: CAPPED_LOGO_IMAGE_MODEL, rateVersion: SUNBURST_STANDARD_IMAGE_PRICING.binding.rateVersion, paidCallsApproved: true },
    connection: { query } as unknown as LogoWorkerConnection, assets, assertAvailable, references: "uploaded", transport: { createImage: generate } };
  return { options, job, resolved, query, denied, generate, assertAvailable };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("explicit shared image runtime dependencies", () => {
  it("is absent by default and constructs exact selected dependencies with zero I/O", () => {
    expect(createLogoImageRuntimeAdapter()).toBeNull();
    for (const operation of ["identity.logo_concept", "identity.logo_refine"] as const) {
      const f = fixture(operation), adapter = createLogoImageRuntimeAdapter(f.options)!;
      expect(adapter.capability).toEqual(f.options.capability);
      expect(!!adapter.concepts).toBe(operation === "identity.logo_concept");
      expect(!!adapter.refinements).toBe(operation === "identity.logo_refine");
      if (adapter.refinements) expect(adapter.refinements.vectorRefinement).toBeNull();
      expect(f.query).not.toHaveBeenCalled(); expect(f.denied).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled(); expect(f.assertAvailable).not.toHaveBeenCalled();
    }
  });
  it.each(["approval", "model", "rate", "key", "cost", "provider", "handler", "operation", "engine", "store", "assertion"])("rejects missing or mismatched %s before I/O", field => {
    const f = fixture(), o = f.options;
    if (field === "approval") o.image.paidCallsApproved = false;
    if (field === "model") o.image.model = "unapproved";
    if (field === "rate") o.image.rateVersion = "unapproved";
    if (field === "key") o.image.apiKey = "";
    if (field === "cost") o.capability = { ...o.capability, maxCostMicrousd: 0 };
    if (field === "provider") o.capability = { ...o.capability, provider: "unapproved" };
    if (field === "handler") o.capability = { ...o.capability, handlerVersion: "unapproved" };
    if (field === "operation") o.capability = { ...o.capability, operation: "identity.logo_directions" };
    if (field === "engine") o.capability = { ...o.capability, engine: { id: "other", version: "1", artifactHash: "a".repeat(64) } };
    if (field === "store") o.assets = null;
    if (field === "assertion") o.assertAvailable = null;
    expect(createLogoImageRuntimeAdapter(o)).toBeNull(); expect(f.query).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
  });
  it("uses the actual frozen-input loader and captures caller configuration and methods", async () => {
    const f = fixture(), adapter = createLogoImageRuntimeAdapter(f.options)!;
    f.options.image.paidCallsApproved = false; f.options.capability = { ...f.options.capability, policyIdentity: "d".repeat(64) };
    f.options.assertAvailable = async () => { throw Error("Changed callback"); };
    expect(await adapter.concepts!.resolveInputs(f.job)).toEqual(f.resolved);
    expect(f.query.mock.calls[0]).toEqual(["select public.read_leased_logo_record($1,$2,$3,$4) value", [f.job.id, f.job.leaseToken, "concept_inputs", "null"]]);
    await adapter.concepts!.assertPolicyReady(f.job); expect(f.assertAvailable).toHaveBeenCalledOnce();
    expect(adapter.capability.policyIdentity).toBe("c".repeat(64)); expect(JSON.stringify(adapter)).not.toContain("synthetic-never-display");
  });
  it.each(["owner", "operation", "policy", "budget", "zero", "project", "handler"])("denies wrong job %s before SQL or external authorization", async field => {
    const f = fixture(), adapter = createLogoImageRuntimeAdapter(f.options)!;
    const job = structuredClone(f.job), input = job.input as Record<string, unknown>;
    if (field === "owner") job.ownerId = id(9);
    if (field === "operation") job.operation = "identity.logo_refine";
    if (field === "policy") input.policyIdentity = "d".repeat(64);
    if (field === "budget") job.reservedCostMicrousd = 2001;
    if (field === "zero") job.reservedCostMicrousd = 0;
    if (field === "project") job.projectId = id(9);
    if (field === "handler") input.handlerVersion = "other";
    await expect(adapter.concepts!.resolveInputs(job)).rejects.toThrow();
    await expect(adapter.concepts!.assertPolicyReady(job)).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled(); expect(f.assertAvailable).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
  });
  it("keeps legacy reference-free rejection and rejects curated references in the new uploaded lane", async () => {
    for (const mode of ["none", "uploaded"] as const) {
      const f = fixture(), ref = syntheticLogoReferences()[mode === "none" ? 1 : 0]!;
      f.resolved.referenceSnapshot.references = [{ asset: ref.asset, sourceKind: ref.sourceKind, referenceId: ref.referenceId, rightsEvidenceId: ref.rightsEvidenceId, aspects: ref.aspects }];
      if (f.resolved.input.operation !== "identity.logo_concept") throw Error("Expected concept");
      f.resolved.input.references = [ref.asset]; f.job.input = f.resolved.input;
      const adapter = createLogoImageRuntimeAdapter({ ...f.options, references: mode })!;
      await expect(adapter.concepts!.resolveInputs(f.job)).rejects.toThrow(); expect(f.generate).not.toHaveBeenCalled(); expect(f.denied).not.toHaveBeenCalled();
    }
  });
  it("uses real raster-refinement loader and never accepts vector-source refinement", async () => {
    const f = fixture("identity.logo_refine"), adapter = createLogoImageRuntimeAdapter(f.options)!;
    expect(await adapter.refinements!.resolveInputs(f.job)).toEqual(f.resolved);
    expect(f.query.mock.calls[0]?.[1]).toEqual([f.job.id, f.job.leaseToken, "refinement_inputs", "null"]);
    const invalid = { ...f.job, input: { ...(f.job.input as object), source: { kind: "vector", vectorRevisionId: id(88), locks: [] } } };
    await expect(adapter.refinements!.resolveInputs(invalid)).rejects.toThrow(); expect(f.generate).not.toHaveBeenCalled();
  });
});


describe("image host stop at the physical request boundary", () => {
  it("prevents injected transport dispatch after asynchronous image preflight observes a stop", async () => {
    const f = fixture(); let active = true;
    const adapter = createLogoImageRuntimeAdapter({ ...f.options, acceptingWork: () => active })!;
    const pending = adapter.concepts!.producer.produce(f.resolved, [], "synthetic-stop", new AbortController().signal);
    active = false;
    expect(await pending).toMatchObject({ status: "not_dispatched", billing: { status: "recorded", confirmedMicrousd: 0 } });
    expect(f.generate).not.toHaveBeenCalled();
  });
  it("retains real post-invocation uncertainty and observed cost when the host stops", async () => {
    const f = fixture(); let active = true;
    const createImage = vi.fn(async (): Promise<never> => {
      active = false;
      throw new OpenAIImageTransportError("outcome_unknown", "synthetic-dispatched", "a".repeat(64),
        { input_tokens: 1, output_tokens: 1, input_tokens_details: { text_tokens: 1, image_tokens: 0 } });
    });
    const adapter = createLogoImageRuntimeAdapter({ ...f.options, transport: { createImage }, acceptingWork: () => active })!;
    expect(await adapter.concepts!.producer.produce(f.resolved, [], "synthetic-stop", new AbortController().signal)).toMatchObject({
      status: "needs_reconciliation", providerRequestId: "synthetic-dispatched", responseHash: "a".repeat(64), billing: { status: "recorded", confirmedMicrousd: 35 },
    });
    expect(createImage).toHaveBeenCalledOnce();
  });
  it("checks the default transport fetch after its second asynchronous byte-validation pass", async () => {
    const f = fixture(); let active = true;
    const request = vi.fn<typeof fetch>(async (): Promise<never> => { throw Error("Stopped default transport must not issue HTTP"); });
    vi.stubGlobal("fetch", request);
    const adapter = createLogoImageRuntimeAdapter({ ...f.options, transport: undefined, acceptingWork: () => active })!;
    const pending = adapter.concepts!.producer.produce(f.resolved, [], "synthetic-stop", new AbortController().signal);
    queueMicrotask(() => { active = false; });
    expect(await pending).toMatchObject({ status: "not_dispatched", billing: { status: "recorded", confirmedMicrousd: 0 } });
    expect(request).not.toHaveBeenCalled();
  });
});

it.each([() => "true", async () => true, async () => { throw Error("Synthetic invalid async lifecycle guard"); }])("requires exact boolean true from the image lifecycle guard", async acceptingWork => {
  const f = fixture();
  const adapter = createLogoImageRuntimeAdapter({ ...f.options, acceptingWork: acceptingWork as unknown as () => boolean })!;
  expect(await adapter.concepts!.producer.produce(f.resolved, [], "synthetic-invalid-guard", new AbortController().signal)).toMatchObject({
    status: "not_dispatched", billing: { status: "recorded", confirmedMicrousd: 0 },
  });
  expect(f.generate).not.toHaveBeenCalled();
});
