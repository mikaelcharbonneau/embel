import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAMING_PREFERENCES_IMPLEMENTATION_HASH, namingPreferencesRuntimeFingerprint } from "../../worker/naming-preferences-fingerprint";

describe("Naming preferences runtime fingerprint", () => {
  it("pins the actual shared implementation bytes and runtime Unicode", () => {
    expect(createHash("sha256").update(readFileSync(new URL("../../src/domain/naming-brain-preferences.ts", import.meta.url))).digest("hex")).toBe(NAMING_PREFERENCES_IMPLEMENTATION_HASH);
    expect(namingPreferencesRuntimeFingerprint()).toEqual({ version: 1, normalizer: "naming-preferences-v1:nfc-lower-nfc", implementationHash: NAMING_PREFERENCES_IMPLEMENTATION_HASH,
      nodeVersion: process.versions.node, icuVersion: process.versions.icu, unicodeVersion: process.versions.unicode });
  });
});
