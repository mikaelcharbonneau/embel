import { isAccountLogoClientCurrent, type AccountLogoClient } from "../../../components/identity/account-logo-client";
import { AccountRequestError } from "../../../components/workspace/account-api";
import type { VerifiedAccount } from "../../../components/workspace/account-session";
import type { FontRecord } from "../../../domain/logo-directions";
import { freezeLogoRecord, logoVectorRevisionSchema, type LogoType, type LogoVectorRevision } from "../../../domain/logo-vector";
import type { AssetVersionReference } from "../../../domain/asset-library";

export type LogoTextEditContext = { briefName: string; logoType: LogoType; fonts: readonly FontRecord[] };
const sameAsset = (a: AssetVersionReference | undefined, b: AssetVersionReference) => Boolean(a && a.ownerId === b.ownerId && a.projectId === b.projectId && a.assetId === b.assetId && a.versionId === b.versionId && a.contentHash === b.contentHash);
const invalid = (): never => { throw new AccountRequestError(502); };
/** Read-only UI hints from exact owned immutable sources. The server repeats all
 * authorization, rights, byte, source and shaping checks before saving an edit. */
export async function loadLogoTextContext(input: { account: VerifiedAccount; client: AccountLogoClient; revision: LogoVectorRevision; isCurrent(): boolean }, signal: AbortSignal): Promise<LogoTextEditContext | null> {
  const revision = logoVectorRevisionSchema.parse(input.revision);
  const current = () => !signal.aborted && input.isCurrent() && isAccountLogoClientCurrent(input.client, input.account, revision.projectId);
  if (!current()) return null;
  if (revision.ownerId !== input.account.userId) return invalid();
  const briefs = revision.inputRevisions.filter(ref => ref.stage === "brief_references");
  if (briefs.length !== 1) return invalid();
  const ref = briefs[0]!, source = revision.source;
  try {
    const [brief, fonts, savedSource] = await Promise.all([
      input.client.getLogoStageRevision("brief_references", ref.id, signal),
      input.client.listLogoFonts(signal),
      source.kind === "concept" ? input.client.readLogoConceptBatch(source.batchId, signal) : input.client.readLogoRasterRefinement(source.rasterRevisionId, signal),
    ]);
    if (!current()) return null;
    if (!brief || brief.stage !== "brief_references" || brief.id !== ref.id || brief.revision !== ref.revision || brief.ownerId !== revision.ownerId || brief.projectId !== revision.projectId || !fonts || !savedSource || savedSource.ownerId !== revision.ownerId || savedSource.projectId !== revision.projectId) return invalid();
    if (new Set(fonts.map(font => font.id)).size !== fonts.length || fonts.some(font => font.asset.ownerId !== revision.ownerId || font.asset.projectId !== revision.projectId)) return invalid();
    let logoType: LogoType;
    if (source.kind === "concept") {
      if (!("slots" in savedSource) || savedSource.id !== source.batchId || savedSource.briefRevisionId !== brief.id) return invalid();
      const slot = savedSource.slots.find(item => item.id === source.slotId), attempt = slot?.attempts.find(item => item.id === source.attemptId);
      if (!slot || !sameAsset(attempt?.preview?.reference, revision.sourcePreview)) return invalid();
      logoType = slot.type;
    } else {
      if (!("logoType" in savedSource) || savedSource.id !== source.rasterRevisionId || !sameAsset(savedSource.preview?.reference, revision.sourcePreview) || savedSource.inputRevisions.length !== revision.inputRevisions.length || savedSource.inputRevisions.some((item, index) => {
        const expected = revision.inputRevisions[index]; return !expected || item.id !== expected.id || item.revision !== expected.revision || item.stage !== expected.stage;
      })) return invalid();
      logoType = savedSource.logoType;
    }
    return freezeLogoRecord({ briefName: brief.payload.name, logoType, fonts });
  } catch (error) { if (!current()) return null; throw error; }
}
