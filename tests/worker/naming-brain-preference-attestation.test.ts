import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { NAMING_PREFERENCES_IMPLEMENTATION_HASH, namingPreferencesRuntimeFingerprint } from "../../worker/naming-brain-configuration";
import { NamingBrainJobStore } from "../../worker/naming-brain-store";
import { id, preferences } from "../domain/naming-brain-fixtures";

describe("Naming trusted shared preference attestation", () => {
  it("pins the actual shared implementation bytes and runtime Unicode", () => {
    expect(createHash("sha256").update(readFileSync(new URL("../../src/domain/naming-brain-preferences.ts", import.meta.url))).digest("hex")).toBe(NAMING_PREFERENCES_IMPLEMENTATION_HASH);
    expect(namingPreferencesRuntimeFingerprint()).toMatchObject({ nodeVersion: process.versions.node, unicodeVersion: process.versions.unicode, icuVersion: process.versions.icu });
  });
  it("attests exact version/hash with shared JavaScript Unicode decisions, never SQL imitation", async () => {
    const actual = namingPreferencesRuntimeFingerprint(), calls: unknown[][] = [];
    const store = new NamingBrainJobStore({ query: async (sql, values = []) => {
      calls.push(values);
      if (sql.includes("get_naming_brain_preference_work")) return { rows: [{ result: [{ ownerId: id(1), projectId: id(2), preferencesVersion: 3, preferences: { ...preferences(), requiredText: ["CAFÉ"], excludedText: ["cafe\u0301"] }, preferencesHash: "a".repeat(64), expectedFingerprint: actual }] }] };
      return { rows: [{ result: { attestationId: id(8), projectId: values[0], preferencesVersion: values[1], preferencesHash: values[2], fingerprint: JSON.parse(String(values[3])), ...JSON.parse(String(values[4])) } }] };
    } }, "synthetic");
    expect(await store.attestPendingPreferences()).toBe(1);
    expect(JSON.parse(String(calls[1]![4]))).toEqual({ ready: false, missing: ["conflicting_text"] });
  });
  it("does not echo a foreign runtime fingerprint or attest incompatible work", async () => {
    let calls = 0;
    const store = new NamingBrainJobStore({ query: async () => { calls++; return { rows: [{ result: [{ ownerId: id(1), projectId: id(2), preferencesVersion: 1, preferences: preferences(), preferencesHash: "a".repeat(64), expectedFingerprint: { ...namingPreferencesRuntimeFingerprint(), unicodeVersion: "wrong" } }] }] }; } }, "synthetic");
    expect(await store.attestPendingPreferences()).toBe(0); expect(calls).toBe(1);
  });
});

it("does not attest raw preferences whose Zod normalization would alter the saved snapshot", async () => {
  let readiness: unknown;
  const store = new NamingBrainJobStore({ query: async (sql, values = []) => {
    if (sql.includes("get_naming_brain_preference_work")) return { rows: [{ result: [{ ownerId: id(1), projectId: id(2), preferencesVersion: 1, preferences: { ...preferences(), notes: " padded " }, preferencesHash: "a".repeat(64), expectedFingerprint: namingPreferencesRuntimeFingerprint() }] }] };
    readiness = JSON.parse(String(values[4]));
    return { rows: [{ result: { attestationId: id(8), projectId: values[0], preferencesVersion: values[1], preferencesHash: values[2], fingerprint: JSON.parse(String(values[3])), ...JSON.parse(String(values[4])) } }] };
  } }, "synthetic");
  await store.attestPendingPreferences(); expect(readiness).toEqual({ ready: false, missing: ["invalid_preferences"] });
});
