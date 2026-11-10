export type LogoVectorErrorCode =
  | "invalid_geometry"
  | "unsupported_svg"
  | "limit_exceeded"
  | "empty_artwork"
  | "invalid_font"
  | "font_rights_required"
  | "unsupported_text"
  | "unsupported_edit"
  | "locked_component_changed"
  | "unsupported_locked_refinement"
  | "source_mismatch"
  | "engine_unavailable"
  | "conversion_failed"
  | "cancelled"
  | "timeout";

/** Stable public reason; never include the untrusted source XML or private asset data. */
export class LogoVectorError extends Error {
  readonly code: LogoVectorErrorCode;
  constructor(code: LogoVectorErrorCode, reason: string) {
    super(reason.replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 300));
    this.name = "LogoVectorError";
    this.code = code;
  }
}
