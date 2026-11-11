import "server-only";
import type { z } from "zod";
import { ApiError } from "./errors";
import { getApplicationOrigin } from "../config";

/** The configured origin is trusted; Host and forwarded headers are not. */
export function assertMutationOrigin(request: Request, allowedOrigin = getApplicationOrigin()): void {
  const origin = request.headers.get("origin");
  if (
    !origin ||
    origin === "null" ||
    origin !== allowedOrigin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new ApiError("forbidden_origin");
  }
}

/** Bound the actual streamed bytes as Content-Length can be absent or false. */
export async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ApiError("internal_error");
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new ApiError("body_too_large");
  if (!request.body) throw new ApiError("invalid_input");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError("body_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function readJson<T extends z.ZodType>(
  request: Request,
  schema: T,
  maxBytes = 32_768,
): Promise<z.output<T>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ApiError("internal_error");
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new ApiError("invalid_input");
  }
  const bytes = await readBoundedBytes(request, maxBytes);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError("invalid_input");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError("invalid_input");
  return parsed.data;
}
