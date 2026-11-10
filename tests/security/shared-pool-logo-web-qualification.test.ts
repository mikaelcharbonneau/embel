import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSharedLogoFixture, type SharedLogoFixture } from "../database/shared-account-logo-fixture";
import { OWNER_A } from "../database/local-supabase";
import { sharedLogoAdvancedHelperSignatures, sharedLogoHttpHelperHashes } from "../../src/server/shared-account/logo-qualification";

const gateway = "public.execute_shared_logo_request(text,text,jsonb,jsonb)";
const currentGatewayHash = "24f89a8859e6c06fc92f15375c80347576b5ee1715ede9ac202c89520d92d851";
const previousGatewayHash = "d94c05dc32745c93c52a41023bed385cd73216c50b48feaa12e9d8bf10fa96a5";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
beforeAll(() => {
 vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fricsfwqibyhemknqgyf.supabase.co");
 vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_inertfixture");
});
afterAll(() => { vi.unstubAllEnvs(); });

async function qualifiesBaselineOnly(f: SharedLogoFixture) {
 const runtime = f.runtime();
 try {
  expect(sharedLogoHttpHelperHashes[gateway]).toEqual([currentGatewayHash]);
  expect(sharedLogoHttpHelperHashes[gateway]).not.toContain(previousGatewayHash);
  const body = (await f.db.query<{ body: string }>("select prosrc body from pg_proc where oid=to_regprocedure($1)", [gateway])).rows[0]!.body;
  expect(sha(body)).toBe(currentGatewayHash);
  for (const signature of sharedLogoAdvancedHelperSignatures) {
   expect((await f.db.query<{ present: boolean }>("select to_regprocedure($1) is not null present", [signature])).rows[0]!.present).toBe(false);
  }
  const workspace = await f.start(OWNER_A);
  expect(await runtime.resolve(f.auth(OWNER_A), workspace.projectId)).toMatchObject({ ownerId: OWNER_A, projectId: workspace.projectId });
  expect(f.calls).toHaveLength(0);
 } finally { await runtime.close(); await f.db.close(); }
}

describe("Logo web qualification composes actual installed SQL", () => {
 it("qualifies baseline-only uploads with the exact current gateway and no advanced delegates", async () => {
  await qualifiesBaselineOnly(await createSharedLogoFixture());
 }, 90_000);
});
