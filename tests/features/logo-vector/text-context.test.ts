import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createAccountLogoClient } from "../../../src/components/identity/account-logo-client";
import { loadLogoTextContext } from "../../../src/features/logo-vector/client/text-context";
import { textEditFixture } from "./text-edit-fixtures";

async function fixture() {
  const f = await textEditFixture(), account = { status: "ready" as const, userId: f.revision.ownerId, generation: 1 };
  let current = true, gate: Promise<void> | null = null;
  const calls: string[] = [];
  const client = createAccountLogoClient(account, f.projectId, () => current, () => { current = false; }, async url => {
    const path = String(url); calls.push(path); if (gate) await gate;
    if (path.includes("/stages/")) return Response.json(f.brief);
    if (path.includes("/raster-refinements/")) return Response.json(f.refinement);
    if (path.endsWith("/fonts")) return Response.json([f.input.font.record]);
    return Response.json({}, { status: 404 });
  });
  const load = (signal = new AbortController().signal) => loadLogoTextContext({ account, client, revision: f.revision, isCurrent: () => current }, signal);
  return { ...f, account, client, load, calls, foreign() { current = false; }, delay(value: Promise<void>) { gate = value; } };
}
describe("owner-fenced exact text-control context", () => {
  it("loads the frozen brief, exact source type and owned fonts without a write", async () => {
    const f = await fixture(), context = await f.load();
    expect(context).toMatchObject({ briefName: "A\u0301ster", logoType: "combination", fonts: [f.input.font.record] });
    expect(f.calls).toHaveLength(3);
  });
  it("does not infer a lettermark from the list of selected brief types", async () => {
    const f = await fixture(); f.brief.payload.logoTypes = ["lettermark_monogram", "combination"];
    expect((await f.load())?.logoType).toBe("combination");
  });
  it.each(["owner", "preview", "input", "font"])("hides mismatched %s context", async mismatch => {
    const f = await fixture();
    if (mismatch === "owner") f.brief.ownerId = randomUUID();
    if (mismatch === "preview") f.refinement.preview!.reference = { ...f.refinement.preview!.reference, assetId: randomUUID() };
    if (mismatch === "input") f.refinement.inputRevisions = [];
    if (mismatch === "font") f.input.font.record.asset.projectId = randomUUID();
    await expect(f.load()).rejects.toBeDefined();
  });
  it.each(["owner", "abort"])("discards a late %s response before exposing any font/name data", async change => {
    const f = await fixture(), controller = new AbortController(); let release!: () => void;
    f.delay(new Promise<void>(resolve => { release = resolve; })); const pending = f.load(controller.signal);
    await vi.waitFor(() => expect(f.calls).toHaveLength(3));
    if (change === "owner") f.foreign(); else controller.abort(); release();
    expect(await pending).toBeNull();
  });
});
