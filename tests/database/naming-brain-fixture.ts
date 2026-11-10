import { asRole, OWNER_A, type TestDatabase } from "./local-supabase";

export const brainReadinessFingerprint={version:1,normalizer:"naming-preferences-v1:nfc-lower-nfc",implementationHash:"7108319323898692a388fcf17cb542509583288b0d4b05d7384f8c5b707aeb01",nodeVersion:process.versions.node,icuVersion:process.versions.icu,unicodeVersion:process.versions.unicode};
export const brainPreferences = { version: 2, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null, approaches: ["real_words"], directness: "open_ended", sourceLanguages: [], heritageNotes: "", culturalNotes: "", requiredText: [], excludedText: [] };
export async function brainRpc<T = Record<string, unknown>>(db: TestDatabase, name: string, args: unknown[], owner = OWNER_A): Promise<T> {
 if (!/^[a-z_]+$/.test(name)) throw Error("Invalid synthetic RPC name");
 return asRole(db, "authenticated", owner, async () => (await db.query<{ result: T }>(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i+1}`).join(",")})) result`, args.map(v => v && typeof v === "object" ? JSON.stringify(v) : v))).rows[0]!.result);
}
