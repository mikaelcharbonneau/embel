import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  buildLogoConceptPrompt,
  buildLogoRefinementPrompt,
  createLogoImageProvider,
  type LogoImageConfiguration,
} from "../../src/server/ai/logo-image-prompts";
import { OpenAIImageTransportError, type OpenAIImageResponse } from "../../src/server/ai/openai-image-transport";
import { CAPPED_LOGO_IMAGE_MODEL, IMAGE_MODEL } from "../../src/domain/providers";
import { syntheticResolvedLogoConcept, syntheticResolvedLogoRefinement } from "../fixtures/logo-creation";
const config: LogoImageConfiguration = {
  apiKey: "synthetic-only",
  model: IMAGE_MODEL,
  policyIdentity: "c".repeat(64),
  handlerVersion: "logo-image-v1",
  priceUsage: (usage) =>
    usage ? { status: "recorded", confirmedMicrousd: 1000 } : { status: "unknown", confirmedMicrousd: null },
};
const result: OpenAIImageResponse = {
  bytes: new Uint8Array([137, 80, 78, 71]),
  mimeType: "image/png",
  providerRequestId: "req_fixture",
  responseHash: "a".repeat(64),
  usage: { input_tokens: 2, output_tokens: 1, input_tokens_details: { text_tokens: 2, image_tokens: 0 } },
};

describe("logo image producer capability and frozen prompt", () => {
  it("missing configuration, blank credentials, unpinned model or malformed policy returns no producer", () => {
    expect(createLogoImageProvider({ configuration: null })).toBeNull();
    for (const patch of [
      { apiKey: "" },
      { model: "other-paid-model" },
      { policyIdentity: "not-policy-evidence" },
      { handlerVersion: "future-v2" },
    ])
      expect(createLogoImageProvider({ configuration: { ...config, ...patch } as LogoImageConfiguration })).toBeNull();
  });
  it("source spelling, every assigned type and direction plus aspects reach original monochrome prompts", () => {
    const source = syntheticResolvedLogoConcept();
    for (const slot of source.input.plan.slots) {
      const prompt = buildLogoConceptPrompt({
        ...source,
        input: { ...source.input, ordinal: slot.ordinal, directionId: slot.directionId },
      });
      expect(prompt).toContain("Élan & Co");
      expect(prompt).toContain("black and white");
      expect(prompt).toContain(slot.type);
      expect(prompt).toContain(slot.directionId);
      expect(prompt).toContain("original");
      expect(prompt).toContain("inspiration");
    }
  });
  it("refinement prompt preserves exact source spelling and instruction without text-provider calls", () => {
    const prompt = buildLogoRefinementPrompt(syntheticResolvedLogoRefinement());
    expect(prompt).toContain("Simplify the silhouette");
    expect(prompt).toContain("Élan & Co");
    expect(prompt).toContain("first image");
  });
  it("uses exact saved policy/model and one supplied attempt ID", async () => {
    const createImage = vi.fn().mockResolvedValue(result);
    const producer = createLogoImageProvider({ configuration: config, transport: { createImage } })!;
    const output = await producer.produce(
      syntheticResolvedLogoConcept(),
      [],
      "original-diagnostic-id",
      new AbortController().signal,
    );
    expect(output).toMatchObject({
      status: "completed",
      bytes: result.bytes,
      billing: { status: "recorded", confirmedMicrousd: 1000 },
    });
    expect(createImage).toHaveBeenCalledTimes(1);
    expect(createImage.mock.calls[0]![1]).toBe("original-diagnostic-id");
    expect(createImage.mock.calls[0]![0].model).toBe(IMAGE_MODEL);
  });
  it("asks for low quality and low complexity on a transparent background; the capped 2.5 policy keeps medium on white", async () => {
    for (const [model, quality, background, wording, other] of [
      [IMAGE_MODEL, "low", "transparent", "fully transparent background", "plain white background"],
      [CAPPED_LOGO_IMAGE_MODEL, "medium", "opaque", "plain white background", "fully transparent background"],
    ] as const) {
      const createImage = vi.fn().mockResolvedValue(result),
        producer = createLogoImageProvider({ configuration: { ...config, model }, transport: { createImage } })!;
      expect(
        (await producer.produce(syntheticResolvedLogoConcept(), [], "trace", new AbortController().signal)).status,
      ).toBe("completed");
      const request = createImage.mock.calls[0]![0];
      expect(request).toMatchObject({ model, quality, background });
      expect(request.complexity).toBe(model === IMAGE_MODEL ? "low" : undefined);
      expect(request.prompt).toContain(wording);
      expect(request.prompt).not.toContain(other);
    }
    expect(buildLogoRefinementPrompt(syntheticResolvedLogoRefinement())).toContain("fully transparent background");
  });
  it("valid preview without usage cannot become a free charge, even with an unsafe mapper", async () => {
    const producer = createLogoImageProvider({
      configuration: { ...config, priceUsage: () => ({ status: "recorded", confirmedMicrousd: 0 }) },
      transport: { createImage: async () => ({ ...result, usage: null }) },
    })!;
    expect(
      await producer.produce(syntheticResolvedLogoConcept(), [], "trace", new AbortController().signal),
    ).toMatchObject({
      status: "completed",
      bytes: result.bytes,
      billing: { status: "unknown", confirmedMicrousd: null },
    });
  });
  it.each(["outcome_unknown", "invalid_response"] as const)("keeps %s evidence without retries", async (code) => {
    const createImage = vi
      .fn()
      .mockRejectedValue(new OpenAIImageTransportError(code, "req_observed", "a".repeat(64), result.usage));
    const producer = createLogoImageProvider({ configuration: config, transport: { createImage } })!;
    expect(
      await producer.produce(syntheticResolvedLogoConcept(), [], "trace", new AbortController().signal),
    ).toMatchObject({
      status: code === "invalid_response" ? "rejected" : "needs_reconciliation",
      code,
      providerRequestId: "req_observed",
      responseHash: "a".repeat(64),
      billing: { status: "recorded", confirmedMicrousd: 1000 },
    });
    expect(createImage).toHaveBeenCalledTimes(1);
  });
  it("draws a concept fresh: a liked upload guides it through its note, never as an attached image", async () => {
    const createImage = vi.fn().mockResolvedValue(result),
      producer = createLogoImageProvider({ configuration: config, transport: { createImage } })!;
    const base = syntheticResolvedLogoConcept(),
      asset = {
        ownerId: base.brief.ownerId,
        projectId: base.brief.projectId,
        assetId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
        versionId: "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1",
        contentHash: "d".repeat(64),
      };
    const input = {
      ...base,
      input: { ...base.input, references: [asset] },
      referenceSnapshot: {
        ...base.referenceSnapshot,
        references: [
          {
            referenceId: "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1",
            asset,
            sourceKind: "upload" as const,
            aspects: ["overall_feel" as const],
            rightsEvidenceId: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1",
          },
        ],
      },
    };
    const image = {
      reference: asset,
      mimeType: "image/png",
      bytes: new Uint8Array([137, 80, 78, 71]),
      verification: {
        status: "verified" as const,
        checkedAt: "2026-11-09T00:00:00.000Z",
        contentHash: asset.contentHash,
        mimeType: "image/png",
        byteLength: 4,
      },
    };
    expect((await producer.produce(input, [image], "trace", new AbortController().signal)).status).toBe("completed");
    expect(createImage.mock.calls[0]![0].images).toEqual([]);
    expect(createImage.mock.calls[0]![0].prompt).toContain('"references":[]');
  });
  it("pre-abort, policy mismatch, missing reference bytes and locked vector source do not dispatch", async () => {
    const createImage = vi.fn().mockResolvedValue(result),
      producer = createLogoImageProvider({ configuration: config, transport: { createImage } })!;
    const input = syntheticResolvedLogoConcept();
    expect((await producer.produce(input, [], "trace", AbortSignal.abort())).status).toBe("not_dispatched");
    expect(
      (
        await producer.produce(
          { ...input, input: { ...input.input, policyIdentity: "a".repeat(64) } },
          [],
          "trace",
          new AbortController().signal,
        )
      ).status,
    ).toBe("not_dispatched");
    expect(
      (await producer.produce(syntheticResolvedLogoRefinement(), [], "trace", new AbortController().signal)).status,
    ).toBe("not_dispatched");
    expect(createImage).not.toHaveBeenCalled();
  });
  it("unknown raw errors expose no credentials/provider body and keep uncertain billing", async () => {
    const producer = createLogoImageProvider({
      configuration: config,
      transport: {
        createImage: async () => {
          throw new Error("PRIVATE SECRET");
        },
      },
    })!;
    const output = await producer.produce(syntheticResolvedLogoConcept(), [], "trace", new AbortController().signal);
    expect(JSON.stringify(output)).not.toContain("PRIVATE SECRET");
    expect(output).toMatchObject({ status: "needs_reconciliation", billing: { status: "unknown" } });
  });
});

it.each([
  ["茶屋", true],
  ["مرحبا", true],
  ["Studio 🦄", false],
])("checks brand asset character coverage before paid Logo generation: %s", async (name, supported) => {
  const createImage = vi.fn().mockResolvedValue(result),
    input = structuredClone(syntheticResolvedLogoConcept());
  input.brief.payload.name = name;
  const producer = createLogoImageProvider({ configuration: config, transport: { createImage } })!;
  const output = await producer.produce(input, [], "font-coverage-test", new AbortController().signal);
  expect(output.status).toBe(supported ? "completed" : "not_dispatched");
  expect(createImage).toHaveBeenCalledTimes(supported ? 1 : 0);
  if (!supported)
    expect(output).toMatchObject({
      code: "unsupported_brand_text",
      billing: { status: "recorded", confirmedMicrousd: 0 },
    });
});
