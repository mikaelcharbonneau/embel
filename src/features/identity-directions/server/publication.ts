import "server-only";
import { z } from "zod";
import type { ClaimedJob } from "@/domain/jobs";
import { fontRecordSchema, identityDirectionProductionResultSchema, type IdentityDirectionProductionResult, type FontTextCheck } from "@/domain/logo-directions";
import { logoApprovalSchema, logoInputRevisionsSchema, logoVectorRevisionSchema } from "@/domain/logo-vector";
import { logoBriefRevisionSchema, logoReferenceSnapshotSchema } from "@/domain/logo-workspace";
import { logoDirectionsJobInputSchema, logoDirectionPublicationReceiptSchema, logoResolvedDirectionInputSchema, logoProviderResponseReceiptSchema, logoProviderHasResponseIdentity, type LogoProviderResponseReceipt } from "@/domain/logo-jobs";
import { parseLogoStored, logoId } from "@/server/data/logo-transaction";
import type { LogoWorkerConnection } from "@/server/data/logo-jobs";
import { productionIdentityAssetStore, type IdentityAssetStore } from "@/server/data/identity-asset-store";
import { ApiError } from "@/server/http/errors";
import { validateLogoVectorDocument } from "@/features/logo-vector/model/geometry";
import { canonicalIdentityInput } from "../model/font-check-binding";
import { createLeasedFontResolver } from "./fonts";
import { inspectTypographySamples } from "./font-inspection";
const snapshotSchema = z.strictObject({ inputRevisions: logoInputRevisionsSchema, approvedLogo: logoApprovalSchema, logoRevision: logoVectorRevisionSchema, brief: logoBriefRevisionSchema, references: logoReferenceSnapshotSchema, permittedFonts: z.array(fontRecordSchema).max(100), targetCount: z.literal(3) });
const same = (a:unknown,b:unknown)=>canonicalIdentityInput(a)===canonicalIdentityInput(b);
async function loadSnapshot(connection: LogoWorkerConnection, job: ClaimedJob) {
  logoId(job.id); logoId(job.leaseToken); const input = logoDirectionsJobInputSchema.parse(job.input);
  if (input.ownerId!==job.ownerId||input.projectId!==job.projectId||job.operation!==input.operation)throw new ApiError("not_found");
  const value = await connection.query<{value:unknown}>("select public.load_logo_direction_inputs($1,$2) value",[job.id,job.leaseToken]);
  const snapshot = parseLogoStored(snapshotSchema,value.rows[0]?.value);
  if (snapshot.approvedLogo.id!==input.approvedLogoId||snapshot.approvedLogo.ownerId!==job.ownerId||snapshot.approvedLogo.projectId!==job.projectId||snapshot.logoRevision.id!==snapshot.approvedLogo.vectorRevisionId||snapshot.logoRevision.ownerId!==job.ownerId||snapshot.logoRevision.projectId!==job.projectId||snapshot.brief.id!==input.briefRevisionId||snapshot.references.id!==input.referenceSnapshotId||!same(snapshot.permittedFonts.map(f=>f.id).sort(),[...input.fontVersionIds].sort()))throw new ApiError("not_found");
  return snapshot;
}
export async function loadDirectionInputs(connection: LogoWorkerConnection, job: ClaimedJob, assets: IdentityAssetStore=productionIdentityAssetStore, signal?:AbortSignal) {
  const snapshot=await loadSnapshot(connection,job); if(signal?.aborted)throw new ApiError("integration_unavailable");
  const file=await assets.readLeasedAsset(job,snapshot.logoRevision.documentAsset,signal);
  if (!same(file.reference,snapshot.logoRevision.documentAsset)||file.mimeType!=="application/json")throw new ApiError("not_found");
  const logo=validateLogoVectorDocument(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(file.bytes)));
  const checked=await loadSnapshot(connection,job); if(!same(snapshot,checked)||signal?.aborted)throw new ApiError("not_found");
  return logoResolvedDirectionInputSchema.parse({inputRevisions:snapshot.inputRevisions,approvedLogo:snapshot.approvedLogo,logo,brief:snapshot.brief,references:snapshot.references,permittedFonts:snapshot.permittedFonts,targetCount:3});
}
export async function stageLogoDirections(connection:LogoWorkerConnection,job:ClaimedJob,input:IdentityDirectionProductionResult,provider:LogoProviderResponseReceipt,assets:IdentityAssetStore,signal:AbortSignal) {
  provider=logoProviderResponseReceiptSchema.parse(provider);
  const frozen=logoDirectionsJobInputSchema.parse(job.input);
  if(!logoProviderHasResponseIdentity(provider)||(frozen.policy ? !("version" in provider)||provider.registrationId!==frozen.policy.registrationId||provider.model!==frozen.policy.model : "version" in provider))throw new ApiError("not_found");
  const result=identityDirectionProductionResultSchema.parse(input),snapshot=await loadSnapshot(connection,job);
  if(provider.jobId!==job.id||provider.leaseToken!==job.leaseToken||provider.ownerId!==job.ownerId||provider.projectId!==job.projectId)throw new ApiError("not_found");
  const resolve=createLeasedFontResolver({loadRecords:async activeJob=>(await loadSnapshot(connection,activeJob)).permittedFonts});
  const fontChecks:FontTextCheck[]=[];
  for(const record of snapshot.permittedFonts){
    const samples=result.typography.flatMap(t=>t.styles.filter(s=>s.fontVersionId===record.id).map(s=>({typographyVersionId:t.id,styleKey:s.key,role:s.role,text:s.sampleText,weight:s.weight,style:s.style})));
    if(samples.length){const permitted=await resolve(job,record,"render",assets,signal);fontChecks.push(...await inspectTypographySamples(permitted,samples,signal));}
  }
  if(signal.aborted)throw new ApiError("integration_unavailable");
  const response=await connection.query<{value:unknown}>("select public.stage_logo_directions($1,$2,$3,$4,$5) value",[job.id,job.leaseToken,JSON.stringify(result),provider.id,JSON.stringify(fontChecks)]);
  return parseLogoStored(logoDirectionPublicationReceiptSchema,response.rows[0]?.value);
}
