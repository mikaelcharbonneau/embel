import "server-only";
import { logoExportRejectionSchema, type LogoExportRejection } from "@/domain/logo-deliverables";
import { ApiError } from "@/server/http/errors";
/** Construct only after validating the durable exact-body SQL rejection. */
export class LogoExportAdmissionRejectedError extends ApiError {
 readonly rejection:LogoExportRejection;
 constructor(rejection:LogoExportRejection){super("conflict");this.name="LogoExportAdmissionRejectedError";this.rejection=logoExportRejectionSchema.parse(rejection);}
}
