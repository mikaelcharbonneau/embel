import "server-only";
import { applyLogoVectorProposalCommandSchema } from "@/features/logo-vector/model/proposal-materialization";
import { z } from "zod";
import {
  logoProjectCreationInputSchema, logoProjectCreationStateSchema, logoProjectCreationPageSchema,
  logoWorkspaceV2Schema, logoCurrentVectorSelectionSchema, logoMutationReceiptSchema, logoManualCommandSchema,
  logoReferenceSnapshotSchema, logoStageRevisionSchema, logoHistoryPageSchema, logoHistoryCursorSchema,
  logoPageQuerySchema, logoStageSchema,
  type LogoWorkspaceV2, type LogoMutationReceipt, type LogoManualCommand, type LogoStage,
  type LogoProjectCreationInput, type LogoProjectCreationState, type LogoProjectCreationPage,
  type LogoReferenceSnapshot, type LogoStageRevision, type LogoHistoryPage, type LogoHistoryCursor,
} from "@/domain/logo-workspace";
import { logoRequestStateSchema, logoConceptBatchSchema, logoConceptBatchPageSchema, logoRasterRefinementSchema, logoRasterRefinementPageSchema, type LogoRequestState, type LogoConceptBatch, type LogoConceptBatchPage, type LogoRasterRefinement, type LogoRasterRefinementPage } from "@/domain/logo-jobs";
import { logoVectorDetailSchema, logoVariantSetSchema, committedIdentityAssetReceiptSchema, type LogoVectorDetail, type LogoVariantSet, type VerifiedAssetBytes } from "@/domain/logo-deliverables";
import { logoVectorRevisionSchema, type LogoVectorRevision, type LogoVectorDocument } from "@/domain/logo-vector";
import type { IdentityAssetStore } from "./identity-asset-store";
import { identityDirectionsOverviewSchema, fontRecordSchema, type IdentityDirectionsOverview, type FontRecord } from "@/domain/logo-directions";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";
import { LogoUncertainCommitError, logoDatabaseError, logoOwner, logoId, parseLogoInput, parseLogoStored } from "./logo-transaction";

const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>;
    return Object.keys(aa).length === Object.keys(bb).length && Object.keys(aa).every(k => Object.hasOwn(bb, k) && same(aa[k], bb[k]));
  }
  return false;
};
function scope(auth: AuthenticatedContext, projectId: string, value: { ownerId: string; projectId: string }): void {
  if (value.ownerId !== logoOwner(auth) || value.projectId !== projectId) throw new ApiError("not_found");
}
function active(signal?: AbortSignal): void { if (signal?.aborted) throw new ApiError("integration_unavailable"); }

/** Authenticated fixed RPCs only. This factory creates no client, connection,
 * job, provider, environment lookup, or alternative account/session boundary. */
export type LogoWorkspaceDependencies = {
  assetStore?: IdentityAssetStore;
  transactions?: {run(auth:AuthenticatedContext,projectId:string,input:unknown,signal?:AbortSignal):Promise<LogoMutationReceipt|LogoVariantSet>};
  verifyVectorRevision?: (input: {revision:LogoVectorRevision;document:VerifiedAssetBytes;svg:VerifiedAssetBytes},signal?:AbortSignal)=>Promise<LogoVectorDocument>;
};
export function createLogoWorkspaceService(dependencies:LogoWorkspaceDependencies={}) {
  async function rpc(auth: AuthenticatedContext, name: string, args: Record<string, unknown>, signal?: AbortSignal,
    mutation?: { projectId: string | null; input: LogoProjectCreationInput | LogoManualCommand }): Promise<unknown> {
    logoOwner(auth); active(signal);
    let response: { data: unknown; error: unknown };
    try {
      const request = auth.client.rpc(name, args);
      response = await (signal ? request.abortSignal(signal) : request);
    } catch (error) {
      if (mutation) throw new LogoUncertainCommitError(mutation.projectId, mutation.input);
      throw logoDatabaseError(error);
    }
    if (response.error) {
      const error = logoDatabaseError(response.error);
      if (mutation && error.code === "integration_unavailable") throw new LogoUncertainCommitError(mutation.projectId, mutation.input);
      throw error;
    }
    if (signal?.aborted && mutation) throw new LogoUncertainCommitError(mutation.projectId, mutation.input);
    active(signal); return response.data;
  }
  async function getLogoWorkspace(auth: AuthenticatedContext, projectId: string, signal?: AbortSignal): Promise<LogoWorkspaceV2> {
    projectId = logoId(projectId);
    const value = parseLogoStored(logoWorkspaceV2Schema, await rpc(auth, "get_logo_workspace", { p_project_id: projectId }, signal));
    scope(auth, projectId, value); return value;
  }
  async function startLogoProject(auth: AuthenticatedContext, input: unknown, signal?: AbortSignal): Promise<LogoWorkspaceV2> {
    logoOwner(auth);
    const body = parseLogoInput(logoProjectCreationInputSchema, input);
    const value = await rpc(auth, "start_logo_project", { p_input: body }, signal, { projectId: null, input: body });
    try {
      const workspace = parseLogoStored(logoWorkspaceV2Schema, value);
      if (workspace.ownerId !== logoOwner(auth)) throw new ApiError("not_found");
      return workspace;
    } catch { throw new LogoUncertainCommitError(null, body); }
  }
  async function readLogoProjectCreation(auth: AuthenticatedContext, requestKey: string): Promise<LogoProjectCreationState> {
    requestKey = logoId(requestKey);
    const state = parseLogoStored(logoProjectCreationStateSchema, await rpc(auth, "read_logo_project_creation", { p_request_key: requestKey }));
    if (state.status === "succeeded" && (state.requestKey !== requestKey || state.workspace.ownerId !== logoOwner(auth))) throw new ApiError("not_found");
    return state;
  }
  async function listLogoProjectCreations(auth: AuthenticatedContext, query: { cursor?: string; limit?: number } = {}): Promise<LogoProjectCreationPage> {
    const parsed = parseLogoInput(logoPageQuerySchema, query);
    const page = parseLogoStored(logoProjectCreationPageSchema, await rpc(auth, "list_logo_project_creations", { p_query: parsed }));
    if (page.ownerId !== logoOwner(auth) || page.items.length > parsed.limit) throw new ApiError("not_found");
    return page;
  }
  async function record(auth: AuthenticatedContext, projectId: string, kind: string, id: string, signal?: AbortSignal): Promise<unknown> {
    return rpc(auth, "read_logo_workspace_record", { p_project_id: logoId(projectId), p_kind: kind, p_id: logoId(id) }, signal);
  }
  async function readLogoReferenceSnapshot(auth: AuthenticatedContext, projectId: string, snapshotId: string): Promise<LogoReferenceSnapshot> {
    projectId = logoId(projectId); snapshotId = logoId(snapshotId);
    const value = parseLogoStored(logoReferenceSnapshotSchema, await record(auth, projectId, "reference_snapshot", snapshotId));
    scope(auth, projectId, value);
    if (value.id !== snapshotId) throw new ApiError("not_found");
    return value;
  }
  async function getLogoStageRevision(auth: AuthenticatedContext, projectId: string, stage: LogoStage, revisionId: string, signal?: AbortSignal): Promise<LogoStageRevision> {
    projectId = logoId(projectId); revisionId = logoId(revisionId); parseLogoInput(logoStageSchema, stage);
    const value = parseLogoStored(logoStageRevisionSchema, await record(auth, projectId, "stage", revisionId, signal));
    scope(auth, projectId, value);
    if (value.id !== revisionId || value.stage !== stage) throw new ApiError("not_found");
    return value;
  }
  async function listLogoStageHistory(auth: AuthenticatedContext, projectId: string, stage: LogoStage,
    query: { cursor?: LogoHistoryCursor; limit?: number } = {}): Promise<LogoHistoryPage> {
    projectId = logoId(projectId); parseLogoInput(logoStageSchema, stage);
    const parsed = parseLogoInput(z.strictObject({ cursor: logoHistoryCursorSchema.optional(), limit: z.number().int().min(1).max(50).default(20) }), query);
    if (parsed.cursor && parsed.cursor.stage !== stage) throw new ApiError("invalid_input");
    const page = parseLogoStored(logoHistoryPageSchema, await rpc(auth, "list_logo_workspace_records", { p_project_id: projectId, p_kind: stage, p_query: parsed }));
    scope(auth, projectId, page);
    if (page.items.length > parsed.limit || page.items.some(i => i.stage !== stage) || (page.nextCursor && page.nextCursor.stage !== stage)) throw new ApiError("integration_unavailable");
    return page;
  }
  async function readLogoManualRequest(auth: AuthenticatedContext, projectId: string, requestKey: string): Promise<LogoRequestState> {
    projectId = logoId(projectId); requestKey = logoId(requestKey);
    const state = parseLogoStored(logoRequestStateSchema, await record(auth, projectId, "manual_request", requestKey));
    if (state.status !== "not_found") {
      if (state.status !== "succeeded" || state.requestKey !== requestKey || !state.receipt) throw new ApiError("integration_unavailable");
      scope(auth, projectId, state.receipt);
    }
    return state;
  }
  async function manual(auth: AuthenticatedContext, projectId: string, method: LogoManualCommand["method"], input: unknown, signal?: AbortSignal): Promise<LogoMutationReceipt> {
    logoOwner(auth); projectId = logoId(projectId); active(signal);
    const command = parseLogoInput(logoManualCommandSchema, { method, body: input });
    const trusted=["saveLogoEdit","acceptLogoVector","selectIdentityDirectionComponents","approveIdentityDirection","reviewLogoVariants"].includes(method)||(command.method==="restoreLogoStage"&&["vector","refinements"].includes(command.body.stage));
    if(trusted){
      if(!dependencies.transactions){await getLogoWorkspace(auth,projectId,signal);throw new ApiError("integration_unavailable");}
      const result=parseLogoStored(logoMutationReceiptSchema,await dependencies.transactions.run(auth,projectId,command,signal));scope(auth,projectId,result);
      const stage=command.method==="restoreLogoStage"?command.body.stage:method==="saveLogoEdit"?"refinements":method==="acceptLogoVector"?"vector":method==="reviewLogoVariants"?"deliverables":"directions";
      if(result.requestKey!==command.body.requestKey||result.revision.stage!==stage||result.workspace.heads.workspaceRevision!==command.body.expected.workspaceRevision+1||result.revision.revision!==command.body.expected.stageRevisions[stage]+1)throw new LogoUncertainCommitError(projectId,command);
      return result;
    }
    const data = await rpc(auth, "apply_logo_workspace_command", { p_project_id: projectId, p_command: command }, signal, { projectId, input: command });
    try {
      const receipt = parseLogoStored(logoMutationReceiptSchema, data); scope(auth, projectId, receipt);
      const stage=command.method==="restoreLogoStage"?command.body.stage:["selectLogoConcept","selectLogoRaster"].includes(command.method)?"concepts":"brief_references";
      if (receipt.requestKey !== command.body.requestKey || receipt.workspace.heads.workspaceRevision !== command.body.expected.workspaceRevision + 1
        || receipt.revision.stage !== stage || receipt.revision.revision !== command.body.expected.stageRevisions[stage] + 1) throw new ApiError("integration_unavailable");
      if (command.method === "saveLogoBrief") {
        if(receipt.revision.stage!=="brief_references")throw new ApiError("integration_unavailable");
        const payload = receipt.revision.payload;
        const saved = { name: payload.name, activity: payload.activity, audience: payload.audience, personality: payload.personality, logoTypes: payload.logoTypes };
        if (!same(saved, command.body.brief)) throw new ApiError("integration_unavailable");
      }
      return receipt;
    } catch { throw new LogoUncertainCommitError(projectId, command); }
  }
  async function unavailable(auth: AuthenticatedContext, projectId: string, signal?: AbortSignal): Promise<never> {
    await getLogoWorkspace(auth, projectId, signal); throw new ApiError("integration_unavailable");
  }
  return {
    startLogoProject, readLogoProjectCreation, listLogoProjectCreations, getLogoWorkspace, readLogoReferenceSnapshot,
    getLogoStageRevision, listLogoStageHistory, readLogoManualRequest,
    saveLogoBrief: (auth: AuthenticatedContext, projectId: string, input: unknown) => manual(auth, projectId, "saveLogoBrief", input),
    saveLogoReferences: (auth: AuthenticatedContext, projectId: string, input: unknown) => manual(auth, projectId, "saveLogoReferences", input),
    restoreLogoStage: (auth: AuthenticatedContext, projectId: string, input: unknown, signal?: AbortSignal) => manual(auth, projectId, "restoreLogoStage", input, signal),
    selectLogoConcept: (auth: AuthenticatedContext, projectId: string, input: unknown) => manual(auth, projectId, "selectLogoConcept", input),
    selectLogoRaster: (auth: AuthenticatedContext, projectId: string, input: unknown) => manual(auth, projectId, "selectLogoRaster", input),
    saveLogoEdit: (auth: AuthenticatedContext, projectId: string, input: unknown, signal?: AbortSignal) => manual(auth, projectId, "saveLogoEdit", input, signal),
    applyLogoVectorProposal: async (auth: AuthenticatedContext, projectId: string, input: unknown, signal?: AbortSignal): Promise<LogoMutationReceipt> => {
      const command = parseLogoInput(applyLogoVectorProposalCommandSchema, { method: "applyLogoVectorProposal", body: input });
      projectId = logoId(projectId); logoOwner(auth); active(signal);
      if (!dependencies.transactions) return unavailable(auth, projectId, signal);
      const raw = await dependencies.transactions.run(auth, projectId, command, signal);
      try {
        const receipt = parseLogoStored(logoMutationReceiptSchema, raw); scope(auth, projectId, receipt);
        if (receipt.requestKey !== command.body.requestKey || receipt.revision.stage !== "refinements" || receipt.revision.payload.vectorRevisionId === null || receipt.revision.payload.approvalId !== null || receipt.revision.payload.sourceRequestKey !== command.body.requestKey || receipt.revision.revision !== command.body.expected.stageRevisions.refinements + 1 || receipt.workspace.heads.workspaceRevision !== command.body.expected.workspaceRevision + 1) throw new ApiError("integration_unavailable");
        return receipt;
      } catch { throw new LogoUncertainCommitError(projectId, command); }
    },
    acceptLogoVector: (auth: AuthenticatedContext, projectId: string, input: unknown, signal?: AbortSignal) => manual(auth, projectId, "acceptLogoVector", input, signal),
    selectIdentityDirectionComponents: (auth: AuthenticatedContext, projectId: string, input: unknown, signal?: AbortSignal) => manual(auth, projectId, "selectIdentityDirectionComponents", input, signal),
    approveIdentityDirection: (auth: AuthenticatedContext, projectId: string, input: unknown, signal?: AbortSignal) => manual(auth, projectId, "approveIdentityDirection", input, signal),
    reviewLogoVariants: (auth: AuthenticatedContext, projectId: string, input: unknown, signal?: AbortSignal) => manual(auth, projectId, "reviewLogoVariants", input, signal),
    prepareLogoVariants: async (auth: AuthenticatedContext, projectId: string, input: unknown, signal?: AbortSignal): Promise<LogoVariantSet> => {
      const command=parseLogoInput(logoManualCommandSchema, { method: "prepareLogoVariants", body: input });
      if(!dependencies.transactions)return unavailable(auth,projectId,signal);
      const set=parseLogoStored(logoVariantSetSchema,await dependencies.transactions.run(auth,logoId(projectId),command,signal));scope(auth,projectId,set);return set;
    },
    readLogoVectorDetail: async (auth: AuthenticatedContext, projectId: string, vectorRevisionId: string, signal?: AbortSignal): Promise<LogoVectorDetail> => {
      projectId=logoId(projectId);vectorRevisionId=logoId(vectorRevisionId);active(signal);
      const raw=await record(auth,projectId,"vector",vectorRevisionId,signal);active(signal);
      if(raw&&typeof raw==="object"&&"ownerId" in raw&&"projectId" in raw)scope(auth,projectId,raw as {ownerId:string;projectId:string});
      const revision=parseLogoStored(logoVectorRevisionSchema,raw);scope(auth,projectId,revision);
      if(revision.id!==vectorRevisionId)throw new ApiError("not_found");
      if(!dependencies.assetStore||!dependencies.verifyVectorRevision)throw new ApiError("integration_unavailable");
      const sourcePreview=parseLogoStored(committedIdentityAssetReceiptSchema,await record(auth,projectId,"vector_source_preview",vectorRevisionId,signal));
      scope(auth,projectId,sourcePreview.reference);
      if(!same(sourcePreview.reference,revision.sourcePreview))throw new ApiError("integration_unavailable");
      try{
        const document=await dependencies.assetStore.readOwnedAsset(auth,revision.documentAsset,signal);
        const svg=await dependencies.assetStore.readOwnedAsset(auth,revision.svgAsset,signal);
        await dependencies.assetStore.readOwnedAsset(auth,revision.sourcePreview,signal);
        active(signal);
        if(!same(document.reference,revision.documentAsset)||!same(svg.reference,revision.svgAsset)||document.mimeType!=="application/json"||svg.mimeType!=="image/svg+xml")throw new ApiError("integration_unavailable");
        const verified=await dependencies.verifyVectorRevision({revision,document,svg},signal);active(signal);
        return parseLogoStored(logoVectorDetailSchema,{revision,document:verified,sourcePreview});
      }catch(error){if(error instanceof ApiError)throw error;throw new ApiError("integration_unavailable");}
    },
    readLogoCurrentVectorRevisionId: async (auth:AuthenticatedContext,projectId:string,signal?:AbortSignal):Promise<string|null>=>{
      projectId=logoId(projectId);
      const selection=parseLogoStored(logoCurrentVectorSelectionSchema,await rpc(auth,"read_logo_current_vector",{p_project_id:projectId},signal));scope(auth,projectId,selection);
      return selection.vectorRevisionId;
    },
    listLogoConceptBatches: async (auth:AuthenticatedContext,projectId:string,query:{cursor?:string;limit?:number}={}):Promise<LogoConceptBatchPage>=>{
      projectId=logoId(projectId);const parsed=parseLogoInput(logoPageQuerySchema,query);
      const page=parseLogoStored(logoConceptBatchPageSchema,await rpc(auth,"list_logo_workspace_records",{p_project_id:projectId,p_kind:"concept_batch",p_query:parsed}));scope(auth,projectId,page);
      if(page.items.length>parsed.limit)throw new ApiError("integration_unavailable");return page;
    },
    readLogoConceptBatch: async (auth: AuthenticatedContext, projectId: string, batchId: string, signal?: AbortSignal): Promise<LogoConceptBatch> => {
      projectId=logoId(projectId);batchId=logoId(batchId);
      const value=parseLogoStored(logoConceptBatchSchema,await record(auth,projectId,"concept_batch",batchId,signal));scope(auth,projectId,value);
      if(value.id!==batchId)throw new ApiError("not_found");return value;
    },
    readLogoRasterRefinement: async (auth: AuthenticatedContext, projectId: string, rasterRevisionId: string, signal?: AbortSignal): Promise<LogoRasterRefinement> => {
      projectId=logoId(projectId);rasterRevisionId=logoId(rasterRevisionId);
      const value=parseLogoStored(logoRasterRefinementSchema,await record(auth,projectId,"raster_refinement",rasterRevisionId,signal));scope(auth,projectId,value);
      if(value.id!==rasterRevisionId)throw new ApiError("not_found");return value;
    },
    listLogoRasterRefinements: async (auth: AuthenticatedContext, projectId: string, query: { cursor?: string; limit?: number } = {}): Promise<LogoRasterRefinementPage> => {
      projectId=logoId(projectId);const parsed=parseLogoInput(logoPageQuerySchema,query);
      const page=parseLogoStored(logoRasterRefinementPageSchema,await rpc(auth,"list_logo_workspace_records",{p_project_id:projectId,p_kind:"raster_refinement",p_query:parsed}));scope(auth,projectId,page);
      if(page.items.length>parsed.limit)throw new ApiError("integration_unavailable");return page;
    },
    getIdentityDirections: async (auth: AuthenticatedContext, projectId: string, query: { cursor?: string; limit?: number } = {}, signal?: AbortSignal): Promise<IdentityDirectionsOverview> => {
      projectId=logoId(projectId);const parsed=parseLogoInput(logoPageQuerySchema,query);
      const page=parseLogoStored(identityDirectionsOverviewSchema,await rpc(auth,"list_logo_workspace_records",{p_project_id:projectId,p_kind:"directions_overview",p_query:parsed},signal));scope(auth,projectId,page);
      if(page.directions.length>parsed.limit)throw new ApiError("integration_unavailable");return page;
    },
    readLogoFontRecord: async (auth:AuthenticatedContext,fontVersionId:string,signal?:AbortSignal):Promise<FontRecord>=>{
      fontVersionId=logoId(fontVersionId);
      const value=parseLogoStored(fontRecordSchema,await rpc(auth,"read_logo_font_record",{p_font_version_id:fontVersionId},signal));
      if(value.asset.ownerId!==logoOwner(auth))throw new ApiError("not_found");
      if(value.id!==fontVersionId)throw new ApiError("not_found");return value;
    },
  };
}
export const {
  startLogoProject, readLogoProjectCreation, listLogoProjectCreations, getLogoWorkspace, readLogoReferenceSnapshot,
  getLogoStageRevision, listLogoStageHistory, readLogoManualRequest, saveLogoBrief, saveLogoReferences,
  restoreLogoStage, selectLogoConcept, selectLogoRaster, saveLogoEdit, applyLogoVectorProposal, acceptLogoVector,
  selectIdentityDirectionComponents, approveIdentityDirection, prepareLogoVariants, reviewLogoVariants,
  readLogoFontRecord, readLogoVectorDetail, readLogoCurrentVectorRevisionId, readLogoConceptBatch, listLogoConceptBatches, readLogoRasterRefinement, listLogoRasterRefinements, getIdentityDirections,
} = createLogoWorkspaceService();
