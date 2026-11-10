import { describe, expect, it, vi } from "vitest";
import { readLogoCandidate } from "../../src/components/logo-creation/candidate-review";
import { syntheticLogoBatch, logoFixtureId as id } from "../fixtures/logo-creation";
import { syntheticRasterRefinement } from "../fixtures/logo-refinement-history";
import type { LogoRasterSource } from "../../src/domain/logo-workspace";

function fixture() {
  const batch = structuredClone(syntheticLogoBatch()),
    refinement = structuredClone(syntheticRasterRefinement()),
    slot = batch.slots[0]!;
  const client = {
    readLogoConceptBatch: vi.fn(async () => batch),
    readLogoRasterRefinement: vi.fn(async () => refinement),
  };
  const source: LogoRasterSource = {
    kind: "concept",
    batchId: batch.id,
    slotId: slot.id,
    attemptId: slot.attempts[0]!.id,
  };
  return {
    batch,
    refinement,
    client,
    source,
    read: (value: LogoRasterSource = source, signal = new AbortController().signal) =>
      readLogoCandidate({ client, ownerId: id(1), projectId: id(2), source: value, signal }),
  };
}

describe("exact saved logo candidate review", () => {
  it("reads the requested concept independently of current selection or open history and preserves successful old attempts", async () => {
    const f = fixture(),
      slot = f.batch.slots[0]!,
      original = structuredClone(slot.attempts[0]!);
    slot.attempts.push({
      ...original,
      id: id(999),
      previousAttemptId: original.id,
      attemptNumber: 2,
      state: "failed",
      preview: null,
    });
    const before = structuredClone(f.batch);
    expect(await f.read()).toMatchObject({
      source: f.source,
      title: "Concept 1",
      preview: original.preview,
      parent: null,
    });
    expect(f.client.readLogoConceptBatch).toHaveBeenCalledExactlyOnceWith(f.batch.id, expect.any(AbortSignal));
    expect(f.client.readLogoRasterRefinement).not.toHaveBeenCalled();
    expect(f.batch).toEqual(before);
  });

  it.each(["owner", "project", "batch", "slot", "attempt", "receipt-owner", "hash", "billing", "state", "publication"])(
    "rejects invalid %s evidence without selecting or creating output",
    async (field) => {
      const f = fixture(),
        slot = f.batch.slots[0]!,
        attempt = slot.attempts[0]!;
      if (field === "owner") f.batch.ownerId = id(999);
      if (field === "project") f.batch.projectId = id(999);
      if (field === "batch") f.batch.id = id(999);
      if (field === "slot") slot.id = id(999);
      if (field === "attempt") attempt.id = id(999);
      if (field === "receipt-owner") attempt.preview!.reference.ownerId = id(999);
      if (field === "hash") attempt.preview!.verification.contentHash = "e".repeat(64);
      if (field === "billing") attempt.billing = { status: "unknown", confirmedMicrousd: null };
      if (field === "state") attempt.state = "needs_reconciliation";
      if (field === "publication") attempt.preview!.publicationState = "staged";
      await expect(f.read()).rejects.toMatchObject({ status: 502 });
    },
  );

  it("reads an exact refinement with its original source and requires settled committed evidence", async () => {
    const f = fixture(),
      source: LogoRasterSource = { kind: "refinement", rasterRevisionId: f.refinement.id };
    expect(await f.read(source)).toMatchObject({ source, parent: f.refinement.source, preview: f.refinement.preview });
    f.refinement.billing = { status: "unknown", confirmedMicrousd: null };
    await expect(f.read(source)).rejects.toMatchObject({ status: 502 });
    expect(f.client.readLogoConceptBatch).not.toHaveBeenCalled();
  });

  it("does not expose a late candidate after cancellation", async () => {
    const f = fixture(),
      controller = new AbortController();
    let finish!: (value: typeof f.batch) => void;
    f.client.readLogoConceptBatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const read = f.read(f.source, controller.signal);
    controller.abort();
    finish(f.batch);
    expect(await read).toBeNull();
    expect(await f.read(f.source, controller.signal)).toBeNull();
    expect(f.client.readLogoConceptBatch).toHaveBeenCalledTimes(1);
  });
});
