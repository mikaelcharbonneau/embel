import {
  LOGO_GEOMETRY_MAX_BYTES, LOGO_VECTOR_MAX_COMMANDS,
  LOGO_VECTOR_MAX_COMPONENTS, LOGO_VECTOR_MAX_PATHS,
} from "../../../domain/logo-vector";
import { LogoVectorError } from "./errors";

export const VECTOR_LIMITS = Object.freeze({
  bytes: LOGO_GEOMETRY_MAX_BYTES, paths: LOGO_VECTOR_MAX_PATHS,
  commands: LOGO_VECTOR_MAX_COMMANDS, components: LOGO_VECTOR_MAX_COMPONENTS,
  xmlDepth: 16, coordinate: 1_000_000, dimension: 16_384,
  strokeWidth: 10_000, miterLimit: 100,
});

export function assertVectorByteLimit(bytes: Uint8Array): void {
  if (bytes.byteLength > VECTOR_LIMITS.bytes) {
    throw new LogoVectorError("limit_exceeded", "Vector input exceeds the 8 MiB limit.");
  }
}

export function assertVectorCount(count: number, limit: number, label: string): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > limit) {
    throw new LogoVectorError("limit_exceeded", `Vector ${label} exceeds its supported limit.`);
  }
}
