/** Synthetic regression subprocess: prevent, rather than perform, any large ZIP allocation. */
import type { ApprovedDeliverableSnapshot } from "../../../src/domain/logo-deliverables";
import type { PreparedLogoExport } from "../../../src/features/identity-deliverables/server/export-types";
const NativeUint8Array = globalThis.Uint8Array;
const rejectedAllocations: number[] = [];
globalThis.Uint8Array = new Proxy(NativeUint8Array, { construct(target, argumentsList) {
  if (typeof argumentsList[0] === "number" && argumentsList[0] >= 52_428_800) {
    rejectedAllocations.push(argumentsList[0]);
    throw new Error("Synthetic sentinel prevented a large preflight allocation");
  }
  return Reflect.construct(target, argumentsList);
} });
process.once("message", async (input: { snapshot: ApprovedDeliverableSnapshot; prepared: PreparedLogoExport }) => {
  try {
    // Load after installing the sentinel so fflate captures the guarded constructor.
    const [{ publishPreparedLogoExport }, { publicationFixture }] = await Promise.all([import("../../../src/features/identity-deliverables/server/publish"), import("./publication-fixture")]);
    const fixture = publicationFixture(input.snapshot); let rejected = false;
    try { await publishPreparedLogoExport(fixture.job, input.snapshot, input.prepared, fixture.dependencies, new AbortController().signal); }
    catch { rejected = true; }
    process.send?.({ rejectedAllocations, rejected, storageWrites: fixture.storage.size }, () => process.disconnect?.());
  } catch { process.send?.({ probeFailed: true }, () => process.disconnect?.()); }
});
