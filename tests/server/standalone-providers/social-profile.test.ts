import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSocialProfileContract } from "@/server/standalone-providers/social-profile";
import type { HandleTarget } from "@/server/standalone-providers/contracts";
import { evidenceFreshnessAt } from "@/domain/standalone-provider-evidence";
import { clock, json, noNetwork, NOW, signal } from "./fixtures";
const target: HandleTarget = { tool: "handles", platform: "youtube", handle: "fixture.handle_1" };
const resource = { kind: "youtube#channel", id: "UC_fixture_channel" };
const body = (items: unknown[] = []) => ({ kind: "youtube#channelListResponse", items });
const check = (response: Response) =>
  createSocialProfileContract({ clock, fetch: async () => response }).check(target, signal());
beforeEach(noNetwork);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("social profile observations", () => {
  it("found_and_empty_are_both_unknown_availability", async () => {
    expect(await check(json(body([resource])))).toMatchObject({
      status: "observed",
      value: { profile: "found", profileId: resource.id, availability: "unknown", ownership: "unverified" },
    });
    const empty = await check(json(body()));
    expect(empty).toMatchObject({
      status: "observed",
      value: { profile: "not_found", profileId: null, availability: "unknown", reservation: "unverified" },
    });
    if (empty.status === "observed") expect(evidenceFreshnessAt(empty.provenance, NOW + 3_600_000)).toBe("stale");
  });
  it.each(["instagram", "tiktok", "x", "linkedin"] as const)(
    "unsupported_platform_sends_nothing: %s",
    async (platform) => {
      const fetch = vi.fn(async () => json(body()));
      expect(
        await createSocialProfileContract({ clock, fetch }).check({ ...target, platform }, signal()),
      ).toMatchObject({ status: "failed", code: "unsupported_target" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("accepts documented channel-list metadata without exposing it in profile observations", async () => {
    const result = await check(
      json({ ...body([resource]), eventId: "demo-event", visitorId: "demo-visitor", tokenPagination: {} }),
    );
    expect(result).toMatchObject({
      status: "observed",
      value: { profile: "found", profileId: resource.id, availability: "unknown" },
    });
    expect(JSON.stringify(result)).not.toMatch(/demo-event|demo-visitor/);
  });
  it("requires positive empty-list evidence and rejects contradictory counts or paging", async () => {
    const envelope = { kind: "youtube#channelListResponse" };
    expect(await check(json({ ...envelope, pageInfo: { totalResults: 0 } }))).toMatchObject({
      status: "observed",
      value: {
        profile: "not_found",
        profileId: null,
        availability: "unknown",
        ownership: "unverified",
        reservation: "unverified",
      },
    });
    for (const malformed of [
      envelope,
      { ...envelope, pageInfo: { resultsPerPage: 5 } },
      { ...envelope, pageInfo: { totalResults: 1 } },
      { ...body([resource]), pageInfo: { totalResults: 0 } },
      { ...body([resource]), pageInfo: { totalResults: 1, resultsPerPage: 0 } },
      { ...body(), pageInfo: { totalResults: 1 } },
      { ...body(), prevPageToken: "previous" },
      { ...body(), tokenPagination: { nextPageToken: "next" } },
    ])
      expect(await check(json(malformed))).toMatchObject({ status: "failed", code: "invalid_response" });
  });
  it("http_status_is_not_profile_evidence", async () => {
    for (const [status, code] of [
      [404, "invalid_response"],
      [403, "not_authorized"],
      [429, "rate_limited"],
    ] as const)
      expect(await check(json(body(), status))).toMatchObject({ status: "failed", code });
    expect(
      await check(new Response("<p>CAPTCHA login</p>", { headers: { "content-type": "text/html" } })),
    ).toMatchObject({ status: "failed", code: "invalid_response" });
  });
  it("rejects_late_or_malformed_lookup", async () => {
    for (const value of [
      { ...body(), kind: "other" },
      body([{ ...resource, kind: "other" }]),
      body([{ ...resource, id: "é" }]),
      body([resource, resource]),
      { ...body(), nextPageToken: "next" },
      { ...body(), error: "fixture-secret" },
      body([{ kind: "youtube#channel" }]),
    ])
      expect(await check(json(value))).toMatchObject({ code: "invalid_response" });
    const controller = new AbortController();
    expect(
      await createSocialProfileContract({
        clock,
        fetch: async () => {
          controller.abort();
          return json(body([resource]));
        },
      }).check(target, controller.signal),
    ).toMatchObject({ code: "cancelled" });
  });
  it("queries_only_the_exact_handle_and_never_profile_html", async () => {
    const requests: Request[] = [];
    const adapter = createSocialProfileContract({
      clock,
      fetch: async (request) => {
        requests.push(request);
        return json(body());
      },
    });
    await adapter.check(target, signal());
    expect(new URL(requests[0]!.url).searchParams.get("forHandle")).toBe(target.handle);
    expect(requests).toHaveLength(1);
    expect(Object.keys(adapter)).toEqual(["check"]);
    await expect(adapter.check({ ...target, handle: "fixture&part=snippet" }, signal())).rejects.toThrow(
      "Invalid provider target",
    );
  });
});
