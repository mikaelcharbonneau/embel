/** Build fingerprint of the shared preferences implementation; the source-byte
 * regression must change with this value. Runtime Unicode/ICU versions are
 * independently bound. The shared worker policy records it for Naming. */
export const NAMING_PREFERENCES_IMPLEMENTATION_HASH = "7108319323898692a388fcf17cb542509583288b0d4b05d7384f8c5b707aeb01";
export function namingPreferencesRuntimeFingerprint() {
  if (!process.versions.node || !process.versions.icu || !process.versions.unicode) throw new Error("naming_normalizer_unavailable");
  return { version: 1, normalizer: "naming-preferences-v1:nfc-lower-nfc", implementationHash: NAMING_PREFERENCES_IMPLEMENTATION_HASH, nodeVersion: process.versions.node, icuVersion: process.versions.icu, unicodeVersion: process.versions.unicode };
}
