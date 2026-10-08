import { z } from "zod";
import { logoExportManifestSchema } from "@/domain/logo-deliverables";
export const assetLogoExportResponseSchema = z.strictObject({ ownerId: z.uuid(), projectId: z.uuid(), versionId: z.uuid(), manifest: logoExportManifestSchema.nullable() }).refine(value => !value.manifest || value.manifest.ownerId === value.ownerId && value.manifest.projectId === value.projectId && value.manifest.files.some(file => file.asset.reference.versionId === value.versionId), "Export evidence must bind the exact owned asset version");
