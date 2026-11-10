import { describe, expect, it } from "vitest";
import { listSelectedAssets, restoreAssetSelection, staleAssets } from "../../src/domain/assets";

const make = (id: string, flags = {}) => ({
  id,
  ownerId: "alice",
  currentVersionId: `${id}-v1`,
  liked: false,
  saved: false,
  used: false,
  ...flags,
});

describe("asset selection and immutable restoration", () => {
  it("implements liked OR saved OR used once per asset, preserving All generations", () => {
    const assets = [
      make("a", { liked: true, saved: true }),
      make("b", { used: true }),
      make("c"),
      make("d", { saved: true }),
      make("e", { ownerId: "bob", liked: true }),
    ];
    expect(listSelectedAssets(assets, "alice", "my_selection").map((a) => a.id)).toEqual(["a", "b", "d"]);
    expect(listSelectedAssets(assets, "alice", "all_generations").map((a) => a.id)).toEqual(["a", "b", "c", "d"]);
    expect(assets).toHaveLength(5);
  });

  it("restores a known version as a new selection, retaining intervening history", () => {
    const versions = [
      { id: "v1", assetId: "a", ownerId: "alice", inputRevision: 1 },
      { id: "v2", assetId: "a", ownerId: "alice", inputRevision: 2 },
    ];
    const selection = restoreAssetSelection({
      actorId: "alice",
      asset: make("a", { currentVersionId: "v2" }),
      versions,
      versionId: "v1",
      expectedVersionId: "v2",
      selectionId: "s3",
      now: "2026-10-02T00:00:00Z",
    });
    expect(selection.versionId).toBe("v1");
    expect(selection.previousVersionId).toBe("v2");
    expect(versions).toHaveLength(2);
    expect(staleAssets(versions, 2).map((v) => v.id)).toEqual(["v1"]);
  });

  it("rejects cross-owner restoration and stale selection writes", () => {
    const input = {
      actorId: "alice",
      asset: make("a"),
      versions: [{ id: "v1", assetId: "a", ownerId: "bob", inputRevision: 1 }],
      versionId: "v1",
      expectedVersionId: "a-v1",
      selectionId: "s3",
      now: "2026-10-02T00:00:00Z",
    };
    expect(() => restoreAssetSelection(input)).toThrow("Version not found");
    expect(() => restoreAssetSelection({ ...input, expectedVersionId: "old" })).toThrow("Selection conflict");
  });
});
