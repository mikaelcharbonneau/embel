import { describe, expect, it } from "vitest";
import { createAccountLogoClient, AccountLogoAdmissionRejectedError } from "../../src/components/identity/account-logo-client";
import { syntheticLogoWorkspace, syntheticLogoQuote, logoFixtureId as id } from "../fixtures/logo-creation";
const saved = syntheticLogoWorkspace(), account = { status: "ready" as const, userId: saved.ownerId, generation: 1 };
const intent = { requestKey: id(801), quoteId: syntheticLogoQuote().id, expected: saved.heads, acceptedMaxCostMicrousd: 12000 };
const proof = { status: "rejected", ownerId: saved.ownerId, projectId: saved.projectId, requestKey: intent.requestKey, quoteId: intent.quoteId };
function client(status: number, body: unknown) {
  return createAccountLogoClient(account, saved.projectId, () => true, () => undefined, async () => Response.json(body, { status }));
}
describe("authenticated admission rejection proof", () => {
  it.each([[409, "conflict"], [404, "not_found"]] as const)("accepts only an exact dedicated HTTP %s rejection", async (status, code) => {
    const transport = client(status, { error: { code, message: "Safe conflict message" }, rejection: proof });
    await expect(transport.admitLogoOperation(intent)).rejects.toBeInstanceOf(AccountLogoAdmissionRejectedError);
    await expect(transport.admitLogoOperation(intent)).rejects.toMatchObject({ rejection: proof });
  });
  it.each(["ownerId", "projectId", "requestKey", "quoteId"] as const)("does not trust a %s mismatch", async field => {
    const transport = client(409, { error: { code: "conflict", message: "Safe message" }, rejection: { ...proof, [field]: id(999) } });
    let error: unknown; try { await transport.admitLogoOperation(intent); } catch (caught) { error = caught; }
    expect(error).not.toBeInstanceOf(AccountLogoAdmissionRejectedError); expect(error).toMatchObject({ status: 409 });
  });
  it("generic 409, wrong code/status and oversized errors never prove rejection", async () => {
    for (const [status, body] of [
      [409, { error: { code: "conflict", message: "Generic conflict" } }],
      [503, { error: { code: "conflict", message: "Wrong status" }, rejection: proof }],
      [409, { error: { code: "not_found", message: "Wrong code" }, rejection: proof }],
      [409, { error: { code: "conflict", message: "x".repeat(5000) }, rejection: proof }],
    ] as const) {
      let error: unknown; try { await client(status, body).admitLogoOperation(intent); } catch (caught) { error = caught; }
      expect(error).not.toBeInstanceOf(AccountLogoAdmissionRejectedError);
    }
  });
});
