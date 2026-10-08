import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createLogoExportsHandler, LOGO_EXPORT_POLICY_IDENTITY } from "../../../worker/handlers/logo-exports";
import { approvedExportFixture, id } from "./fixtures";
import { publicationFixture } from "./publication-fixture";
describe("synthetic zero-provider-cost export handler", () => {
  it("rechecks readiness after loading frozen inputs before starting a new render", async () => {
    const snapshot = await approvedExportFixture(), fixture = publicationFixture(snapshot);
    let ready = true;
    const handler = createLogoExportsHandler({ loadInput: async () => { ready = false; return snapshot; }, assertReady: async () => { if (!ready) throw new Error("Readiness expired while loading"); }, publication: fixture.dependencies });
    expect(await handler.steps(fixture.job)[0]!.execute({ job: fixture.job, signal: new AbortController().signal })).toMatchObject({ status: "failed", costMicrousd: 0 });
    expect(fixture.storage.size).toBe(0);
  });
  it("pins the exact canonical renderer policy and rejects a mismatched frozen identity", async () => {
    expect(LOGO_EXPORT_POLICY_IDENTITY).toBe("fa35a3d5e43410d69832d1d0b35f24b8de4f68df8ea4d790e78a2dc06cbe797c");
    const snapshot=await approvedExportFixture(),fixture=publicationFixture(snapshot),loadInput=vi.fn(async()=>snapshot),assertReady=vi.fn(async()=>undefined);
    const handler=createLogoExportsHandler({loadInput,assertReady,publication:fixture.dependencies});
    const changed={...fixture.job,input:{...(fixture.job.input as Record<string,unknown>),policyIdentity:"f".repeat(64)}};
    expect(()=>handler.steps(changed)).toThrow("Unsupported export handler policy");
    expect(loadInput).not.toHaveBeenCalled();expect(assertReady).not.toHaveBeenCalled();expect(fixture.storage.size).toBe(0);
  });

  it("returns staged receipt id for shared completeStep, never a separately committed manifest", async () => {
    const snapshot = await approvedExportFixture(), fixture = publicationFixture(snapshot);
    const handler = createLogoExportsHandler({ loadInput: async () => snapshot, assertReady: async () => undefined, publication: fixture.dependencies });
    const [step] = handler.steps(fixture.job);
    expect(step?.key).toBe("prepare-export");
    expect(step?.maximumCostMicrousd).toBe(0);
    expect(handler.steps(fixture.job)[0]!.key).toBe(step!.key);
    const result = await step!.execute({ job: fixture.job, signal: new AbortController().signal });
    expect(result).toEqual({ status: "succeeded", costMicrousd: 0, providerRequestId: null, result: { version: 2, kind: "logo_export", publicationId: id(750) } });
  });
  it("uncertain stage acknowledgement remains reconciliation without overwriting files", async () => {
    const snapshot = await approvedExportFixture(), fixture = publicationFixture(snapshot); fixture.loseStageAcknowledgement();
    const handler = createLogoExportsHandler({ loadInput: async () => snapshot, assertReady: async () => undefined, publication: fixture.dependencies });
    expect(await handler.steps(fixture.job)[0]!.execute({ job: fixture.job, signal: new AbortController().signal })).toMatchObject({ status: "needs_reconciliation", code: "export_publication_unknown", costMicrousd: 0 });
    expect(fixture.storage.size).toBeGreaterThan(0);
  });
  it("mismatched source or unavailable readiness produces no byte publication", async () => {
    const snapshot = await approvedExportFixture(), fixture = publicationFixture(snapshot);
    const handler = createLogoExportsHandler({ loadInput: async () => ({ ...snapshot, sourceSnapshotHash: "f".repeat(64) }), assertReady: async () => undefined, publication: fixture.dependencies });
    expect(await handler.steps(fixture.job)[0]!.execute({ job: fixture.job, signal: new AbortController().signal })).toMatchObject({ status: "failed", costMicrousd: 0 });
    expect(fixture.storage.size).toBe(0);
    const unavailable = createLogoExportsHandler({ loadInput: async () => snapshot, assertReady: async () => { throw new Error("No capability"); }, publication: fixture.dependencies });
    expect(await unavailable.steps(fixture.job)[0]!.execute({ job: fixture.job, signal: new AbortController().signal })).toMatchObject({ status: "failed", costMicrousd: 0 });
  });
  it("durably stages earlier verified logo files when required guidelines fail", async () => {
    const snapshot = await approvedExportFixture(); snapshot.brandName = "Synthetic \u{10FFFF}";
    const fixture = publicationFixture(snapshot);
    const handler = createLogoExportsHandler({ loadInput: async () => snapshot, assertReady: async () => undefined, publication: fixture.dependencies });
    const result = await handler.steps(fixture.job)[0]!.execute({ job: fixture.job, signal: new AbortController().signal });
    expect(result).toEqual({ status: "failed", code: "export_file_failed", costMicrousd: 0, providerRequestId: null, result: { version: 2, kind: "logo_export_partial", publicationId: id(750) } });
    expect(fixture.details()).toMatchObject({ completeness: "partial", failure: "file_failed" });
    expect(fixture.storage.size).toBe(9); expect([...fixture.storage.values()].some(file => file.mimeType === "application/zip")).toBe(false);
  });
  it("lost partial-group acknowledgement is reconciliation with the original file identities", async () => {
    const snapshot = await approvedExportFixture(); snapshot.brandName = "Synthetic \u{10FFFF}";
    const fixture = publicationFixture(snapshot); fixture.loseStageAcknowledgement();
    const handler = createLogoExportsHandler({ loadInput: async () => snapshot, assertReady: async () => undefined, publication: fixture.dependencies });
    expect(await handler.steps(fixture.job)[0]!.execute({ job: fixture.job, signal: new AbortController().signal })).toMatchObject({ status: "needs_reconciliation", code: "export_publication_unknown" });
    expect(fixture.storage.size).toBe(9);
  });
});
