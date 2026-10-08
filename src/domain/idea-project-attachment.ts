import { z } from "zod";
import { ideaContentSchema } from "./ideas";
import { logoUuidSchema as uuid,logoRevisionSchema as revision,logoTimestampSchema as timestamp,boundedLogoJson as bounded,uniqueLogoValues as unique } from "./logo-vector";
export const attachIdeaToProjectInputSchema=bounded(z.strictObject({requestKey:uuid,ideaId:uuid,expectedIdeaRevision:revision,projectId:uuid,expectedProjectRevision:revision}));
export type AttachIdeaToProjectInput=z.infer<typeof attachIdeaToProjectInputSchema>;
export const ideaProjectAttachmentReceiptSchema=bounded(z.strictObject({ownerId:uuid,requestKey:uuid,association:z.strictObject({id:uuid,ideaId:uuid,ideaRevision:revision,projectId:uuid,projectRevision:revision,createdAt:timestamp}),source:z.strictObject({content:ideaContentSchema})}),65_536);
export type IdeaProjectAttachmentReceipt=z.infer<typeof ideaProjectAttachmentReceiptSchema>;
/** One immutable response per exact request. Existing links retain their original
 * receipt and target revision; a fresh attempt never relabels that history. */
export const ideaProjectAttachmentOutcomeSchema=bounded(z.strictObject({
 ownerId:uuid,requestKey:uuid,status:z.enum(["attached","already_attached"]),
 input:attachIdeaToProjectInputSchema,attachment:ideaProjectAttachmentReceiptSchema,
}).refine(v=>v.requestKey===v.input.requestKey&&v.ownerId===v.attachment.ownerId&&
 v.attachment.association.ideaId===v.input.ideaId&&v.attachment.association.ideaRevision===v.input.expectedIdeaRevision&&
 v.attachment.association.projectId===v.input.projectId&&
 (v.status==="already_attached"||(v.attachment.requestKey===v.requestKey&&v.attachment.association.projectRevision===v.input.expectedProjectRevision)),
 "Outcome must bind the exact owned request and immutable association"),65_536);
export type IdeaProjectAttachmentOutcome=z.infer<typeof ideaProjectAttachmentOutcomeSchema>;

export const ideaProjectAttachmentPageSchema=bounded(z.strictObject({ownerId:uuid,projectId:uuid,items:z.array(ideaProjectAttachmentReceiptSchema).max(50),nextCursor:z.string().min(1).max(2048).nullable()}).refine(v=>v.items.every(i=>i.ownerId===v.ownerId&&i.association.projectId===v.projectId)&&unique(v.items.map(i=>i.association.id))&&unique(v.items.map(i=>i.requestKey)),"Associations must belong to the same owned project"),3_276_800);
export type IdeaProjectAttachmentPage=z.infer<typeof ideaProjectAttachmentPageSchema>;
