import "server-only";
import { z } from "zod";
import { logoUuidSchema } from "@/domain/logo-vector";
import { LOGO_INPUT_METADATA_MAX_BYTES } from "@/features/logo-inputs/model/contracts";
import { ApiError } from "./errors";

export function logoInputId(value: string): string {
  const parsed = logoUuidSchema.safeParse(value);
  if (!parsed.success) throw new ApiError("invalid_input");
  return parsed.data;
}

/** All input listings use bounded, unique, explicitly allowed query keys. */
export function readLogoInputQuery<T>(request: Request, schema: z.ZodType<T>): T {
  const search = new URL(request.url).search;
  if (search.length > 4096) throw new ApiError("invalid_input");
  const params = new URLSearchParams(search);
  if ([...params.keys()].some((key) => !["cursor", "limit"].includes(key) || params.getAll(key).length !== 1))
    throw new ApiError("invalid_input");
  const value: Record<string, unknown> = Object.fromEntries(params);
  if (params.has("cursor")) value.cursor = logoInputId(params.get("cursor")!);
  if (params.has("limit")) {
    if (!/^\d+$/.test(params.get("limit")!)) throw new ApiError("invalid_input");
    value.limit = Number(params.get("limit"));
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError("invalid_input");
  return parsed.data;
}
export function assertNoLogoInputQuery(request: Request): void {
  readLogoInputQuery(request, z.strictObject({}));
}

const MULTIPART_OVERHEAD_MAX_BYTES = 16_384;
const MULTIPART_HEADER_MAX_BYTES = 8_192;
function assertActiveUpload(request: Request): void {
  if (request.signal.aborted) throw new ApiError("integration_unavailable");
}

/** Reject an oversized original stream before any multipart parser can allocate fields. */
async function readUploadBytes(request: Request, maximum: number): Promise<Buffer> {
  assertActiveUpload(request);
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    throw new ApiError("body_too_large");
  if (!request.body) throw new ApiError("invalid_input");
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      assertActiveUpload(request);
      const next = await reader.read();
      assertActiveUpload(request);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) {
        try {
          await reader.cancel();
        } catch {
          /* Preserve the safe size error. */
        }
        throw new ApiError("body_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

/** Preflight limits parser objects to two parts with small plain headers. The
 * platform parser still owns multipart decoding; this is only its resource fence. */
function checkMultipartEnvelope(bytes: Buffer, boundary: string): Buffer[] {
  const first = Buffer.from(`--${boundary}\r\n`),
    marker = Buffer.from(`\r\n--${boundary}`);
  if (!bytes.subarray(0, first.length).equals(first)) throw new ApiError("invalid_input");
  let start = first.length;
  const parts: Buffer[] = [];
  while (true) {
    if (parts.length >= 2) throw new ApiError("invalid_input");
    const headersEnd = bytes.indexOf("\r\n\r\n", start);
    if (headersEnd < 0) throw new ApiError("invalid_input");
    if (headersEnd - start > MULTIPART_HEADER_MAX_BYTES) throw new ApiError("body_too_large");
    const headers = bytes.subarray(start, headersEnd).toString("latin1").split("\r\n"),
      names = new Set<string>();
    for (const header of headers) {
      const name = header.slice(0, header.indexOf(":")).toLowerCase();
      if (!["content-disposition", "content-type"].includes(name) || names.has(name))
        throw new ApiError("invalid_input");
      names.add(name);
    }
    if (!names.has("content-disposition")) throw new ApiError("invalid_input");
    let end = headersEnd + 4;
    while (true) {
      end = bytes.indexOf(marker, end);
      if (end < 0) throw new ApiError("invalid_input");
      const suffix = bytes.subarray(end + marker.length, end + marker.length + 2).toString("latin1");
      if (suffix === "--" || suffix === "\r\n") break;
      end += marker.length;
    }
    parts.push(bytes.subarray(headersEnd + 4, end));
    const suffixStart = end + marker.length;
    if (bytes.subarray(suffixStart, suffixStart + 2).toString("latin1") === "--") {
      const tail = bytes.subarray(suffixStart + 2);
      if (parts.length !== 2 || !(tail.length === 0 || tail.equals(Buffer.from("\r\n"))))
        throw new ApiError("invalid_input");
      return parts;
    }
    start = suffixStart + 2;
  }
}

/** Browser wire contract: exactly `input` JSON text and one `file`. Filenames,
 * owner IDs and client paths never select storage or identify an account. */
export async function readLogoInputUpload<T>(
  request: Request,
  schema: z.ZodType<T>,
  options: { maximum: number; minimum: number; mimeTypes: readonly string[] },
): Promise<{ input: T; bytes: Uint8Array; mimeType: string }> {
  assertActiveUpload(request);
  const contentType = request.headers.get("content-type") ?? "";
  const match =
    /^multipart\/form-data\s*;\s*boundary=(?:"([A-Za-z0-9'()+_,.\/:=?-]{1,70})"|([A-Za-z0-9'()+_,.\/:=?-]{1,70}))$/i.exec(
      contentType,
    );
  if (!match) throw new ApiError("invalid_input");
  const body = await readUploadBytes(
    request,
    options.maximum + LOGO_INPUT_METADATA_MAX_BYTES + MULTIPART_OVERHEAD_MAX_BYTES,
  );
  const parts = checkMultipartEnvelope(body, match[1] ?? match[2]!);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new ApiError("invalid_input");
  }
  assertActiveUpload(request);
  const entries = [...form.entries()],
    metadata = form.get("input"),
    file = form.get("file");
  if (
    entries.length !== 2 ||
    form.getAll("input").length !== 1 ||
    form.getAll("file").length !== 1 ||
    typeof metadata !== "string" ||
    !(file instanceof File)
  )
    throw new ApiError("invalid_input");
  const metadataBytes = parts[entries.findIndex(([name]) => name === "input")]!;
  const metadataSize = metadataBytes.byteLength;
  if (
    metadataSize > LOGO_INPUT_METADATA_MAX_BYTES ||
    file.size > options.maximum ||
    body.length - metadataSize - file.size > MULTIPART_OVERHEAD_MAX_BYTES
  )
    throw new ApiError("body_too_large");
  if (file.size < options.minimum || !options.mimeTypes.includes(file.type)) throw new ApiError("invalid_input");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes));
  } catch {
    throw new ApiError("invalid_input");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError("invalid_input");
  const bytes = new Uint8Array(await file.arrayBuffer());
  assertActiveUpload(request);
  return { input: parsed.data, bytes, mimeType: file.type };
}
