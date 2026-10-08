import { z } from "zod";
import { createProjectInputSchema } from "./projects";
import { accountProjectSchema } from "./project-api";
import { logoUuidSchema as uuid,logoRevisionSchema as revision,logoHashSchema as hash,logoStringSchema as text,logoTimestampSchema as timestamp,boundedLogoJson as bounded,uniqueLogoValues as unique,freezeLogoRecord } from "./logo-vector";

export const attachmentMimeTypeSchema=z.enum(["text/plain","application/pdf","image/png","image/jpeg"]);
/** Reversible reviewed-plan proposal, not an active capability or an upload validator. */
export const PROPOSED_HOME_ATTACHMENT_POLICY=freezeLogoRecord({allowedMimeTypes:["text/plain","application/pdf","image/png","image/jpeg"] as ("text/plain"|"application/pdf"|"image/png"|"image/jpeg")[],maxFiles:5,maxFileBytes:10_485_760,maxTotalBytes:26_214_400});
export const attachmentPolicySchema=z.strictObject({allowedMimeTypes:z.array(attachmentMimeTypeSchema).min(1).max(4).refine(unique,"Duplicate MIME type"),maxFiles:z.number().int().min(1).max(5),maxFileBytes:z.number().int().min(1).max(10_485_760),maxTotalBytes:z.number().int().min(1).max(26_214_400)}).refine(v=>v.maxFileBytes<=v.maxTotalBytes,"Per-file limit cannot exceed the combined limit");
export type AttachmentPolicy=z.infer<typeof attachmentPolicySchema>;
/** null means unavailable; parsing does not provision storage or admit files. */
export const attachmentCapabilitySchema=attachmentPolicySchema.nullable();
export const ownedAttachmentRefSchema=bounded(z.strictObject({id:uuid,ownerId:uuid,projectId:uuid.nullable(),projectRevision:revision.nullable(),blobVersionId:uuid,contentHash:hash,mimeType:attachmentMimeTypeSchema,byteLength:z.number().int().min(1).max(10_485_760),name:text.min(1).max(255),sourceReceiptId:uuid,state:z.enum(["staged","linked"])}).refine(v=>v.state==="staged"?v.projectId===null&&v.projectRevision===null:v.projectId!==null&&v.projectRevision!==null,"Attachment state must match exact project linkage"));
export type OwnedAttachmentRef=z.infer<typeof ownedAttachmentRefSchema>;
export const draftAttachmentSchema=bounded(z.strictObject({localId:uuid,name:text.min(1).max(255),mimeType:attachmentMimeTypeSchema,byteLength:z.number().int().min(1).max(10_485_760),state:z.enum(["local","uploading","uploaded","uncertain","error"]),ownedRef:ownedAttachmentRefSchema.nullable()}).refine(v=>(v.state!=="uploaded"||v.ownedRef!==null)&&(!v.ownedRef||(v.ownedRef.name===v.name&&v.ownedRef.mimeType===v.mimeType&&v.ownedRef.byteLength===v.byteLength)),"Draft attachment metadata must match its owned receipt"));
export type DraftAttachment=z.infer<typeof draftAttachmentSchema>;
// Reuse the existing project/context validator while rejecting extra response fields.
export const attachmentAccountProjectSchema=accountProjectSchema.strict().extend({id:uuid,owner_id:uuid,current_revision:revision,created_at:timestamp});
export const attachedProjectDraftReceiptSchema=bounded(z.strictObject({ownerId:uuid,requestKey:uuid,project:attachmentAccountProjectSchema,attachments:z.array(ownedAttachmentRefSchema).max(5)}).refine(v=>v.project.owner_id===v.ownerId&&unique(v.attachments.map(a=>a.id))&&v.attachments.every(a=>a.ownerId===v.ownerId&&a.projectId===v.project.id&&a.projectRevision===v.project.current_revision&&a.state==="linked")&&v.attachments.reduce((n,a)=>n+a.byteLength,0)<=26_214_400,"Attachment receipt must bind one owned project revision"),65_536);
export type AttachedProjectDraftReceipt=z.infer<typeof attachedProjectDraftReceiptSchema>;
export type RequestLookup<T>={status:"not_found"}|{status:"pending";requestKey:string}|{status:"committed";receipt:T};
export function requestLookupSchema<T>(receipt:z.ZodType<T>):z.ZodType<RequestLookup<T>> {return z.discriminatedUnion("status",[z.strictObject({status:z.literal("not_found")}),z.strictObject({status:z.literal("pending"),requestKey:uuid}),z.strictObject({status:z.literal("committed"),receipt})]);}
export const stageHomeAttachmentInputSchema=bounded(z.strictObject({requestKey:uuid,name:text.min(1).max(255),mimeType:attachmentMimeTypeSchema,contentHash:hash}));
export type StageHomeAttachmentInput=z.infer<typeof stageHomeAttachmentInputSchema>;
export const attachedProjectDraftInputSchema=bounded(z.strictObject({requestKey:uuid,project:createProjectInputSchema,attachmentIds:z.array(uuid).max(5).refine(unique,"Duplicate attachment")}));
export type AttachedProjectDraftInput=z.infer<typeof attachedProjectDraftInputSchema>;
