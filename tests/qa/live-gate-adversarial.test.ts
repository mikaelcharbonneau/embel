import { describe, expect, it, vi } from "vitest";
import { readLiveConfig } from "../live/gate";

// These are inert placeholders, never credentials. The suite does not create clients.
const approved = "abcdefghijklmnopqrst";
const fixture = {
  FLUID_RUN_LIVE_TESTS: "1",
  FLUID_LIVE_PROJECT_REF: approved,
  FLUID_LIVE_PUBLISHABLE_KEY: "sb_publishable_qa_fixture_only",
  FLUID_LIVE_USER_A_ACCESS_TOKEN: "fixture.ownerA.signature",
  FLUID_LIVE_USER_B_ACCESS_TOKEN: "fixture.ownerB.signature",
  FLUID_LIVE_USER_A_PROJECT_ID: "aaaaaaaa-1111-4111-8111-111111111111",
  FLUID_LIVE_USER_B_PROJECT_ID: "bbbbbbbb-1111-4111-8111-111111111111",
  FLUID_LIVE_USER_A_ASSET_VERSION_ID: "aaaaaaaa-2222-4222-8222-222222222222",
  FLUID_LIVE_USER_B_ASSET_VERSION_ID: "bbbbbbbb-2222-4222-8222-222222222222",
};

describe("independent live-test gate attacks (no network)", () => {
  it("never reads credentials while disabled or while the target is explicitly locked", () => {
    const credentialRead = vi.fn(() => {
      throw new Error("Credential getter must never run");
    });
    const env = { FLUID_RUN_LIVE_TESTS: "0", FLUID_LIVE_PROJECT_REF: approved };
    Object.defineProperty(env, "FLUID_LIVE_PUBLISHABLE_KEY", { get: credentialRead });
    expect(readLiveConfig(env)).toBeNull();
    env.FLUID_RUN_LIVE_TESTS = "1";
    expect(() => readLiveConfig(env, null)).toThrow("locked");
    expect(credentialRead).not.toHaveBeenCalled();
  });

  it("does not accept an alternate destination from ambient application settings", () => {
    const parsed = readLiveConfig(
      {
        ...fixture,
        SUPABASE_URL: "https://unapproved.invalid",
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
        FLUID_LIVE_URL: "https://unapproved.invalid",
        FLUID_APPROVED_LIVE_PROJECT_REF: "wrongprojectreference",
      },
      approved,
    );
    expect(parsed?.url).toBe(`https://${approved}.supabase.co`);
    for (const ref of [
      "https://unapproved.invalid",
      `${approved}.unapproved.invalid`,
      `${approved}/path`,
      approved.toUpperCase(),
    ]) {
      expect(() => readLiveConfig({ ...fixture, FLUID_LIVE_PROJECT_REF: ref }, approved)).toThrow("does not match");
    }
  });

  it("rejects malformed credentials without reflecting their contents in errors", () => {
    const cases = [
      { FLUID_LIVE_PUBLISHABLE_KEY: "sb_secret_qa_only_for_error_redaction" },
      { FLUID_LIVE_PUBLISHABLE_KEY: `sb_publishable_${"k".repeat(257)}` },
      { FLUID_LIVE_USER_A_ACCESS_TOKEN: "fixture.ownerA.signature\r\nInjected: value" },
      { FLUID_LIVE_USER_A_ACCESS_TOKEN: `fixture.${"x".repeat(16384)}.signature` },
      { FLUID_LIVE_USER_B_ASSET_VERSION_ID: "invalid_fixture_identifier_qa" },
    ];
    for (const overrides of cases) {
      let failure: unknown;
      try {
        readLiveConfig({ ...fixture, ...overrides }, approved);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      for (const rejected of Object.values(overrides)) expect(message).not.toContain(rejected);
      expect(message.length).toBeLessThan(180);
    }
  });
});
