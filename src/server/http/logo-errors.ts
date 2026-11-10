import "server-only";
import { LogoVectorError } from "@/features/logo-vector/model/errors";
import { ApiError, errorResponse } from "./errors";

/** Translate only the known feature error class. Never expose source XML,
 * private file metadata, worker exceptions, or raw database/provider messages. */
export function logoErrorResponse(error: unknown): Response {
  if (!(error instanceof LogoVectorError)) return errorResponse(error);
  if (error.code === "locked_component_changed") return errorResponse(new ApiError("conflict"));
  switch (error.code) {
    case "invalid_geometry":
    case "unsupported_svg":
    case "limit_exceeded":
    case "empty_artwork":
    case "invalid_font":
    case "font_rights_required":
    case "unsupported_text":
    case "unsupported_edit":
    case "unsupported_locked_refinement":
      return errorResponse(new ApiError("invalid_input"));
    default:
      return errorResponse(new ApiError("integration_unavailable"));
  }
}
