import type { AuthenticatedContext } from "../../../src/server/auth/context";
import type { LogoRasterRefinement } from "../../../src/domain/logo-jobs";
import { applyLogoTextEdit } from "../../../src/features/logo-vector/server/text-edits";
import { applyLogoManualEdit } from "../../../src/features/logo-vector/model/edits";
import { createVectorHttpFixture, source, base, ownerId, projectId } from "./http-fixture";
import { licensedTextInput } from "./text-fixtures";

/** Synthetic HTTP/save receipts; real font bytes and actual HarfBuzz text edit.
 * It provides no evidence of hosted storage, provider calls or live concurrency. */
export function createTextVectorHttpFixture() {
  const input = licensedTextInput(source.brief.payload.name);
  input.font.record.asset = { ...input.font.record.asset, ownerId, projectId };
  const errors: unknown[] = [], cancellations = new Map<string, unknown>(), cancelPosts: unknown[] = [];
  const controls = { rejectEdit: false, loseCancellation: false };
  const f = createVectorHttpFixture({ async applyEdit(document, edit) {
    if (!["text", "font", "spacing", "replace_outlined_lettering"].includes(edit.kind)) return applyLogoManualEdit(document, edit);
    const detail = [...f.details.values()].find(item => item.document === document)!;
    try { return await applyLogoTextEdit({ auth: { userId: ownerId } as AuthenticatedContext, projectId, revision: detail.revision, document, edit }, {
      async readBriefRevision() { return source.brief; }, async readRasterRefinement() { return raster(); },
      async readConceptBatch() { throw Error("No synthetic concept source"); }, async listFonts() { return [input.font.record]; }, async resolveFont() { return input.font; },
    }, new AbortController().signal); } catch (error) { errors.push(error); throw error; }
  } });
  function raster(): LogoRasterRefinement {
    return { version: 2, id: f.initial.revision.source.kind === "refinement" ? f.initial.revision.source.rasterRevisionId : "", ownerId, projectId,
      requestKey: source.input.requestKey, jobId: source.input.quoteId, source: { kind: "vector", vectorRevisionId: f.initial.revision.id }, logoType: "combination", state: "succeeded", preview: f.preview,
      providerResponseReceiptId: source.input.quoteId, billing: { status: "recorded", confirmedMicrousd: 0 }, reason: null, inputRevisions: f.initial.revision.inputRevisions, createdAt: "2026-10-07T00:00:00Z" };
  }
  const fetcher: typeof fetch = async (url, options) => {
    const path = new URL(String(url), "http://127.0.0.1:3117").pathname;
    if (f.state.owner === ownerId && path.startsWith(`${base}/edits/requests/`)) {
      const requestKey = path.slice(`${base}/edits/requests/`.length).split("/")[0]!;
      const receipt = f.state.requests.get(requestKey), original = f.state.posts.find(item => item.path === `${base}/edits` && item.body.requestKey === requestKey);
      if (receipt && original) return Response.json({ status: "succeeded", ownerId, projectId, requestKey, command: { method: "saveLogoEdit", body: original.body }, receipt });
      if (path.endsWith("/cancel") && options?.method === "POST") {
        const command = JSON.parse(String(options.body)); cancelPosts.push(command);
        const proof = { status: "cancelled", ownerId, projectId, requestKey, command }; cancellations.set(requestKey, proof);
        if (controls.loseCancellation) throw new Error("Lost synthetic cancellation acknowledgement"); return Response.json(proof);
      }
      return Response.json(cancellations.get(requestKey) ?? { status: "not_found" });
    }
    if (f.state.owner === ownerId && path === `${base}/edits` && options?.method === "POST" && controls.rejectEdit) {
      f.state.posts.push({ path, body: JSON.parse(String(options.body)) }); return Response.json({ error: { code: "invalid_input", message: "Synthetic unsupported font" } }, { status: 422 });
    }
    if (f.state.owner === ownerId && path === `${base}/fonts`) return Response.json([input.font.record]);
    if (f.state.owner === ownerId && path.startsWith(`${base}/raster-refinements/`)) return Response.json(raster());
    return f.fetcher(url, options);
  };
  return { ...f, fetcher, input, errors, controls, cancelPosts };
}
