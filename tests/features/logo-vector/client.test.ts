import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountLogoClient } from "../../../src/components/identity/account-logo-client";
import { createVectorHttpFixture, source } from "./http-fixture";
const account = { status: "ready" as const, userId: source.input.ownerId, generation: 1 };
describe("owned saved-vector geometry client reader", () => {
  afterEach(() => vi.restoreAllMocks());
  it("resolves bounded inspected vector detail", async () => {
    const f = createVectorHttpFixture(), client = createAccountLogoClient(account, source.input.projectId, () => true, () => {}, f.fetcher);
    expect(await client.readLogoVectorDetail(f.initial.revision.id)).toEqual(f.initial);
  });
  it("rejects a different returned immutable revision", async () => {
    const f = createVectorHttpFixture();
    const client = createAccountLogoClient(account, source.input.projectId, () => true, () => {}, async () => Response.json(f.initial));
    await expect(client.readLogoVectorDetail(source.input.quoteId)).rejects.toMatchObject({ status: 502 });
  });
  it("rejects schema-shaped geometry that has no visible ink", async () => {
    const f = createVectorHttpFixture(); f.initial.document.components.forEach(c => c.paths.forEach(p => { if (p.fill) p.fill.opacity = 0; p.stroke = null; }));
    const client = createAccountLogoClient(account, source.input.projectId, () => true, () => {}, async () => Response.json(f.initial));
    await expect(client.readLogoVectorDetail(f.initial.revision.id)).rejects.toMatchObject({ status: 502 });
  });
  it.each(["paint", "path", "document-proof", "svg-proof", "validator"] as const)("rejects valid geometry with a changed %s under the original immutable revision", async change => {
    const f = createVectorHttpFixture(), revision = f.initial.revision;
    if (change === "paint") f.initial.document.components[0]!.paths[0]!.fill!.color = "#123456";
    if (change === "path") f.initial.document.components[0]!.paths[0]!.d = "M 22 40 L 40 20 L 60 40 L 40 60 Z";
    if (change === "document-proof") revision.documentHash = revision.proof.documentHash = revision.documentAsset.contentHash = "b".repeat(64);
    if (change === "svg-proof") revision.proof.svgContentHash = revision.svgAsset.contentHash = "b".repeat(64);
    if (change === "validator") revision.proof.validator.version = "unqualified-version";
    const client = createAccountLogoClient(account, source.input.projectId, () => true, () => {}, async () => Response.json(f.initial));
    await expect(client.readLogoVectorDetail(revision.id)).rejects.toMatchObject({ status: 502 });
  });
  it.each((["account", "abort", "late-error"] as const).flatMap(change => [1, 2].map(ordinal => ({ change, ordinal }))))("fences $change while browser digest $ordinal is pending", async ({ change, ordinal }) => {
    const f = createVectorHttpFixture(), controller = new AbortController(); let current = true, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), original = crypto.subtle.digest.bind(crypto.subtle);
    let round = 0;
    const hashing = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, bytes) => {
      round++; if (round === ordinal) { await gate; if (change === "late-error") throw new Error("Late digest failure"); } return original(algorithm, bytes);
    });
    const client = createAccountLogoClient(account, source.input.projectId, () => current, () => {}, async () => Response.json(f.initial));
    const pending = client.readLogoVectorDetail(f.initial.revision.id, controller.signal);
    await vi.waitFor(() => expect(hashing).toHaveBeenCalledTimes(ordinal));
    if (change === "abort") controller.abort(); else current = false;
    release(); expect(await pending).toBeNull();
  });
});
