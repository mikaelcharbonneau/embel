import type { z } from "zod";
import { PROJECT_MUTATION_MAX_BYTES } from "@/domain/project-api";
import { announceOutOfCredits } from "@/components/billing/out-of-credits";

/** The server's `error.code` values the browser acts on. The two 503 codes tell a switched-off step
 * (`generation_unavailable`: nothing was admitted) from an admitted run whose workflow did not start. */
export type AccountErrorCode =
  "naming_history_capacity" | "project_busy" | "billing_pending" | "generation_unavailable" | "start_unconfirmed";
const ACCOUNT_ERROR_CODES: Record<number, readonly AccountErrorCode[]> = {
  409: ["naming_history_capacity", "project_busy", "billing_pending"],
  503: ["generation_unavailable", "start_unconfirmed"],
};

export class AccountRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code?: AccountErrorCode,
  ) {
    super("The account request could not be completed.");
  }
}

/** Retain allowlisted public codes only; never expose arbitrary server messages or read large error bodies. */
export async function safeAccountErrorCode(response: Response): Promise<AccountErrorCode | undefined> {
  const allowed = ACCOUNT_ERROR_CODES[response.status];
  if (
    !allowed ||
    response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" ||
    Number(response.headers.get("content-length")) > 4096
  )
    return undefined;
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const bytes = new Uint8Array(4096);
  let length = 0;
  try {
    for (let chunks = 0; chunks < 64; chunks += 1) {
      const { done, value } = await reader.read();
      if (done) {
        const body: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
        if (
          body &&
          typeof body === "object" &&
          "error" in body &&
          body.error &&
          typeof body.error === "object" &&
          "code" in body.error
        ) {
          const code: unknown = body.error.code;
          return allowed.find((item) => item === code);
        }
        return undefined;
      }
      if (length + value.byteLength > bytes.byteLength) return undefined;
      bytes.set(value, length);
      length += value.byteLength;
    }
  } catch {
    return undefined;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return undefined;
}

/** Private browser requests always go through our same-origin API. */
export async function accountRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  options: {
    signal: AbortSignal;
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    expectedOwnerId?: string;
  },
): Promise<T> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body !== undefined && new TextEncoder().encode(body).byteLength > PROJECT_MUTATION_MAX_BYTES)
    throw new AccountRequestError(413);
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    mode: "same-origin",
    cache: "no-store",
    signal: options.signal,
    headers: {
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.expectedOwnerId ? { "X-Embel-Account": options.expectedOwnerId } : {}),
    },
    ...(body === undefined ? {} : { body }),
  });
  if (!response.ok) {
    if (response.status === 402) announceOutOfCredits();
    throw new AccountRequestError(response.status, await safeAccountErrorCode(response));
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new AccountRequestError(502);
  }
  const parsed = schema.safeParse(result);
  if (!parsed.success) throw new AccountRequestError(502);
  return parsed.data;
}

export function accountErrorMessage(error: unknown) {
  if (error instanceof AccountRequestError) {
    if (error.status === 404) return "This project is not available to this account.";
    if (error.status === 413)
      return "This brief is too large to save. Shorten your notes or audience details and try again. Your edits are still here.";
    if (error.status === 503) return "Account saving is unavailable. Your edits are still in this tab.";
    if (error.status === 422) return "Some details could not be saved. Review your brief and audience fields.";
    if (error.status === 502) return "The account response could not be verified. Your edits are still in this tab.";
  }
  return "The account could not be reached. Your edits are still in this tab. Try again.";
}
