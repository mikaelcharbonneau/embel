import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  createSunburstStandardImageUsagePricer,
  SUNBURST_STANDARD_IMAGE_PRICING,
} from "../../src/server/ai/openai-image-pricing";
import type { LogoImageUsage } from "../../src/server/ai/openai-image-transport";

const binding = {
  model: "gpt-image-2.6-sunburst",
  api: "direct-images",
  serviceTier: "standard",
  rateVersion: "2026-10-07.v1",
};
const usage = { input_tokens: 50, output_tokens: 50, input_tokens_details: { text_tokens: 10, image_tokens: 40 } };
const unknown = { status: "unknown", confirmedMicrousd: null };
function price(raw: unknown) {
  const mapper = createSunburstStandardImageUsagePricer(binding);
  expect(mapper).toBeTypeOf("function");
  return mapper!(raw as LogoImageUsage | null);
}

describe("versioned Standard direct Images pricing, synthetic counts only", () => {
  it("pins the exact model, rates, version and both direct endpoints without mutable global rates", () => {
    expect(SUNBURST_STANDARD_IMAGE_PRICING).toEqual({
      binding,
      currency: "USD",
      verifiedAt: "2026-11-09",
      endpoints: ["/v1/images/generations", "/v1/images/edits"],
      microusdPerToken: { textInput: 5, imageInput: 8, imageOutput: 30 },
    });
    expect(Object.isFrozen(SUNBURST_STANDARD_IMAGE_PRICING)).toBe(true);
    expect(Object.isFrozen(SUNBURST_STANDARD_IMAGE_PRICING.binding)).toBe(true);
    expect(Object.isFrozen(SUNBURST_STANDARD_IMAGE_PRICING.endpoints)).toBe(true);
    expect(Object.isFrozen(SUNBURST_STANDARD_IMAGE_PRICING.microusdPerToken)).toBe(true);
  });
  it("prices each modality once as exact integer micro-USD with or without consistent optional evidence", () => {
    expect(price(usage)).toEqual({ status: "recorded", confirmedMicrousd: 1870 });
    expect(price({ ...usage, total_tokens: 100, output_tokens_details: { text_tokens: 0, image_tokens: 50 } })).toEqual(
      { status: "recorded", confirmedMicrousd: 1870 },
    );
    expect(
      price({ input_tokens: 1, output_tokens: 0, input_tokens_details: { text_tokens: 1, image_tokens: 0 } }),
    ).toEqual({ status: "recorded", confirmedMicrousd: 5 });
    expect(
      price({ input_tokens: 1, output_tokens: 0, input_tokens_details: { text_tokens: 0, image_tokens: 1 } }),
    ).toEqual({ status: "recorded", confirmedMicrousd: 8 });
    expect(
      price({ input_tokens: 0, output_tokens: 1, input_tokens_details: { text_tokens: 0, image_tokens: 0 } }),
    ).toEqual({ status: "recorded", confirmedMicrousd: 30 });
  });
  it("does not grant direct Images cached-input discounts or charge unrelated token totals twice", () => {
    expect(
      price({
        ...usage,
        total_tokens: 100,
        input_tokens_details: { ...usage.input_tokens_details, cached_tokens: 50 },
        cached_tokens: 50,
      }),
    ).toEqual({ status: "recorded", confirmedMicrousd: 1870 });
  });
  it("records complete explicit zero usage, without inferring missing fields as zero", () => {
    expect(
      price({ input_tokens: 0, output_tokens: 0, input_tokens_details: { text_tokens: 0, image_tokens: 0 } }),
    ).toEqual({ status: "recorded", confirmedMicrousd: 0 });
    expect(
      price({
        input_tokens: 0,
        output_tokens: 0,
        input_tokens_details: { text_tokens: 0, image_tokens: 0 },
        total_tokens: 0,
        output_tokens_details: { text_tokens: 0, image_tokens: 0 },
      }),
    ).toEqual({ status: "recorded", confirmedMicrousd: 0 });
    expect(price({ input_tokens: 0, output_tokens: 0 })).toEqual(unknown);
    expect(price({ input_tokens: 0, output_tokens: 0, input_tokens_details: {} })).toEqual(unknown);
  });
  it.each([
    null,
    undefined,
    {},
    [],
    "usage",
    0,
    { input_tokens: 50, output_tokens: 50 },
    { ...usage, input_tokens: 49 },
    { ...usage, input_tokens_details: { text_tokens: 10 } },
    { ...usage, input_tokens_details: { image_tokens: 40 } },
    { ...usage, total_tokens: 99 },
    { ...usage, total_tokens: null },
    { ...usage, total_tokens: "100" },
    { ...usage, total_tokens: 100.5 },
    { ...usage, output_tokens_details: null },
    { ...usage, output_tokens_details: {} },
    { ...usage, output_tokens_details: { image_tokens: 50 } },
    { ...usage, output_tokens_details: { text_tokens: 0 } },
    { ...usage, output_tokens_details: { text_tokens: 1, image_tokens: 49 } },
    { ...usage, output_tokens_details: { text_tokens: 0, image_tokens: 51 } },
  ])("leaves incomplete, malformed or contradictory usage unknown (%j)", (raw) => expect(price(raw)).toEqual(unknown));
  it.each([
    -1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    1_000_000_001,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    null,
  ])("rejects unsafe or out-of-bound token counts in every modality (%s)", (count) => {
    expect(price({ ...usage, input_tokens: count })).toEqual(unknown);
    expect(price({ ...usage, output_tokens: count })).toEqual(unknown);
    expect(price({ ...usage, input_tokens_details: { text_tokens: count, image_tokens: 40 } })).toEqual(unknown);
    expect(price({ ...usage, input_tokens_details: { text_tokens: 10, image_tokens: count } })).toEqual(unknown);
    expect(price({ ...usage, output_tokens_details: { text_tokens: count, image_tokens: 50 } })).toEqual(unknown);
    expect(price({ ...usage, output_tokens_details: { text_tokens: 0, image_tokens: count } })).toEqual(unknown);
  });
  it("keeps the exact upper parser-bound observation with a two-billion total, without treating it as a spend reservation", () => {
    const result = price({
      input_tokens: 1_000_000_000,
      output_tokens: 1_000_000_000,
      input_tokens_details: { text_tokens: 0, image_tokens: 1_000_000_000 },
      total_tokens: 2_000_000_000,
      output_tokens_details: { text_tokens: 0, image_tokens: 1_000_000_000 },
    });
    expect(result).toEqual({ status: "recorded", confirmedMicrousd: 38_000_000_000 });
    expect(Number.isSafeInteger(result.confirmedMicrousd)).toBe(true);
    expect(
      price({
        input_tokens: 2_000_000_000,
        output_tokens: 0,
        input_tokens_details: { text_tokens: 1_000_000_000, image_tokens: 1_000_000_000 },
      }),
    ).toEqual(unknown);
  });
  it.each([-1, NaN, Infinity, 2_000_000_001, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe or out-of-bound aggregate totals (%s)",
    (total_tokens) => {
      expect(price({ ...usage, total_tokens })).toEqual(unknown);
    },
  );
  it("prices the capped policy's pinned 2.5 snapshot at the same rates", () => {
    const capped = createSunburstStandardImageUsagePricer({ ...binding, model: "gpt-image-2.5-sunburst-2026-09-08" });
    expect(capped?.(usage)).toEqual({ status: "recorded", confirmedMicrousd: 1870 });
  });
  it.each([
    { ...binding, model: "gpt-image-2.6-sunburst-2026-10-28" },
    { ...binding, model: "gpt-image-2.6-flare" },
    { ...binding, model: "gpt-image-2.5-sunburst" },
    { ...binding, model: "gpt-image-2" },
    { ...binding, model: "gpt-image-2.5-sunburst-2026-10-08" },
    { ...binding, api: "responses" },
    { ...binding, api: "batch" },
    { ...binding, serviceTier: "batch" },
    { ...binding, serviceTier: "priority" },
    { ...binding, rateVersion: "2026-10-08.v1" },
    { ...binding, rateVersion: "" },
    { model: binding.model },
    null,
  ])("does not create a mapper for an unsupported or incomplete pricing binding (%j)", (raw) => {
    expect(createSunburstStandardImageUsagePricer(raw as typeof binding)).toBeNull();
  });
  it("snapshots an explicit accepted binding instead of changing rates after caller mutation", () => {
    const mutable = { ...binding },
      mapper = createSunburstStandardImageUsagePricer(mutable);
    expect(mapper).toBeTypeOf("function");
    mutable.model = "unsupported";
    mutable.serviceTier = "batch";
    expect(mapper!(usage)).toEqual({ status: "recorded", confirmedMicrousd: 1870 });
  });
});
