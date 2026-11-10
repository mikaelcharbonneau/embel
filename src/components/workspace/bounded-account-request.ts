import type { z } from "zod";
import { accountRequest, AccountRequestError } from "./account-api";

/** Bound the HTTP acknowledgement, never a durable job or its provider runtime. */
export function boundedAccountRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  options: Parameters<typeof accountRequest>[2],
): Promise<T> {
  if (options.signal.aborted) return Promise.reject(options.signal.reason);
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      action();
    };
    const abort = () => {
      finish(() => reject(options.signal.reason));
      controller.abort(options.signal.reason);
    };
    const timer = setTimeout(() => {
      // The server may have committed a mutation. Existing receipt/revision
      // recovery handles the uncertain outcome; a timeout never retries a write.
      finish(() => reject(new AccountRequestError(408)));
      controller.abort();
    }, 30_000);
    options.signal.addEventListener("abort", abort, { once: true });
    void accountRequest(path, schema, { ...options, signal: controller.signal }).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
