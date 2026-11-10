import { describe, expect, it } from "vitest";
import { readLiveConfig } from "./gate";

const approved = "abcdefghijklmnopqrst";
const fixture = {
  FLUID_RUN_LIVE_TESTS: "1",
  FLUID_LIVE_PROJECT_REF: approved,
  FLUID_LIVE_PUBLISHABLE_KEY: "sb_publishable_local_fixture_only",
  FLUID_LIVE_USER_A_ACCESS_TOKEN: "fixture.userA.signature",
  FLUID_LIVE_USER_B_ACCESS_TOKEN: "fixture.userB.signature",
  FLUID_LIVE_USER_A_PROJECT_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  FLUID_LIVE_USER_B_PROJECT_ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  FLUID_LIVE_USER_A_ASSET_VERSION_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  FLUID_LIVE_USER_B_ASSET_VERSION_ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
};

describe("live integration gate (no network)", () => {
  it("does not inspect credentials unless explicitly enabled", () => {
    expect(readLiveConfig({})).toBeNull();
    expect(readLiveConfig({ ...fixture, FLUID_RUN_LIVE_TESTS: "0" })).toBeNull();
    expect(() => readLiveConfig({ ...fixture, FLUID_RUN_LIVE_TESTS: "true" }, approved)).toThrow("must be 1");
  });

  it("remains locked until a verified development target is recorded", () => {
    expect(() => readLiveConfig(fixture, null)).toThrow("locked");
    expect(() => readLiveConfig({ ...fixture, FLUID_LIVE_PROJECT_REF: "wrong-target" }, approved)).toThrow(
      "does not match",
    );
    expect(() => readLiveConfig(fixture, "https://unexpected.example")).toThrow("locked");
  });

  it("rejects elevated keys, missing fixtures, or reused identities without disclosing values", () => {
    for (const key of ["sb_secret_sensitive_value", "eyJ.legacy.signature", ""]) {
      expect(() => readLiveConfig({ ...fixture, FLUID_LIVE_PUBLISHABLE_KEY: key }, approved)).toThrow(
        "publishable key",
      );
    }
    expect(() => readLiveConfig({ ...fixture, FLUID_LIVE_USER_A_PROJECT_ID: undefined }, approved)).toThrow(
      "identity A",
    );
    expect(() =>
      readLiveConfig({ ...fixture, FLUID_LIVE_USER_B_ACCESS_TOKEN: fixture.FLUID_LIVE_USER_A_ACCESS_TOKEN }, approved),
    ).toThrow("distinct");
    expect(() =>
      readLiveConfig({ ...fixture, FLUID_LIVE_USER_B_PROJECT_ID: fixture.FLUID_LIVE_USER_A_PROJECT_ID }, approved),
    ).toThrow("distinct");
    expect(() =>
      readLiveConfig({ ...fixture, FLUID_LIVE_USER_A_ACCESS_TOKEN: "sensitive-invalid-token" }, approved),
    ).toThrow("temporary access token");
  });

  it("derives the only network target from the allowlisted project", () => {
    const config = readLiveConfig({ ...fixture, SUPABASE_URL: "https://unexpected.example" }, approved);
    expect(config?.url).toBe(`https://${approved}.supabase.co`);
    expect(config?.a.projectId).toBe(fixture.FLUID_LIVE_USER_A_PROJECT_ID);
  });
});
