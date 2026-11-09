import { z } from "zod";
import { logoDirectionsApiPolicySchema,logoStyleNoteApiPolicySchema } from "../../src/domain/logo-jobs";
import { identityGenerationCapabilitySchema, type IdentityGenerationCapability } from "../../src/domain/identity-jobs";
import { qualifiedLogoRasterCapability, type LogoRasterCapability } from "../logo-generative-storage-authorization";
import { qualifiedLogoProductionStorageCapability } from "../logo-production-storage-authorization";
import { qualifiedLogoVectorProposalCapability,qualifiedUncappedLogoVectorProposalCapability } from "../logo-vector-proposal-capability";
import type { LogoVectorProposalCapability } from "../logo-vector/proposal-runtime-adapter";
export const sharedDirectionsCapabilitySchema=z.strictObject({operation:z.literal("identity.logo_directions"),policyIdentity:z.string().regex(/^[a-f0-9]{64}$/u),
 handlerVersion:z.literal("logo-directions-api-v1"),provider:z.literal("openai"),model:z.literal("gpt-6.1-sol"),engine:z.null(),spendControl:z.literal("uncapped"),apiPolicy:logoDirectionsApiPolicySchema});
export type SharedDirectionsCapability=z.infer<typeof sharedDirectionsCapabilitySchema>;
/** A liked upload's style note: one text request under the exact note policy. */
export const sharedStyleNoteCapabilitySchema=z.strictObject({operation:z.literal("identity.logo_style_note"),policyIdentity:z.string().regex(/^[a-f0-9]{64}$/u),
 handlerVersion:z.literal("logo-style-note-v1"),provider:z.literal("openai"),model:z.literal("gpt-6.1-sol"),engine:z.null(),spendControl:z.literal("uncapped"),apiPolicy:logoStyleNoteApiPolicySchema});
export type SharedStyleNoteCapability=z.infer<typeof sharedStyleNoteCapabilitySchema>;
export type SharedLogoCapability=LogoRasterCapability|LogoVectorProposalCapability|IdentityGenerationCapability|SharedDirectionsCapability|SharedStyleNoteCapability;
function freeze<T>(value:T):T{if(value&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
/** Exact operation-specific descriptors. A model name never selects a handler,
 * rights, billing route, font, storage object or runtime by itself. */
export function qualifySharedLogoCapability(raw:unknown):SharedLogoCapability|null{
 const identity=identityGenerationCapabilitySchema.safeParse(raw);if(identity.success)return freeze(identity.data);
 const directions=sharedDirectionsCapabilitySchema.safeParse(raw);if(directions.success)return freeze(directions.data);
 const styleNote=sharedStyleNoteCapabilitySchema.safeParse(raw);if(styleNote.success)return freeze(styleNote.data);
 const proposal=qualifiedUncappedLogoVectorProposalCapability(raw)??qualifiedLogoVectorProposalCapability(raw);if(proposal)return freeze(proposal);
 return qualifiedLogoRasterCapability(raw)??qualifiedLogoProductionStorageCapability(raw);
}
