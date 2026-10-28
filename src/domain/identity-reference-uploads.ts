import { z } from "zod";
import { identityReferenceEntrySchema, identityReferenceSchema } from "./identity-references";
import { referenceUploadInputSchema, logoInputRequestStateSchema } from "@/features/logo-inputs/model/contracts";

export const identityReferenceUploadMetadataSchema = z.strictObject({ attribution: identityReferenceSchema.shape.attribution, relevantElements: identityReferenceSchema.shape.relevantElements, tags: identityReferenceSchema.shape.tags });
export const identityReferenceUploadSchema = z.strictObject({ upload: referenceUploadInputSchema, metadata: identityReferenceUploadMetadataSchema })
  .refine(value => value.metadata.attribution.rightsNote === value.upload.rightsDeclaration, "Keep the exact permission declaration as the rights note.");
export type IdentityReferenceUpload = z.infer<typeof identityReferenceUploadSchema>;
export const identityReferenceUploadLookupSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("registered"), entry: identityReferenceEntrySchema }),
  z.strictObject({ status: z.literal("upload"), upload: logoInputRequestStateSchema }),
]);
