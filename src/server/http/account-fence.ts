import { z } from "zod";
import { ApiError } from "./errors";

/** A stale tab must never write its draft into a newly signed-in account.
 * The authenticated session still determines ownership; this header only
 * rejects a request whose captured account no longer matches that session.
 */
export function assertExpectedAccount(request: Request, userId: string) {
  const expected = z.uuid().safeParse(request.headers.get("X-Embel-Account"));
  if (!expected.success || expected.data.toLowerCase() !== userId.toLowerCase()) {
    throw new ApiError("unauthenticated");
  }
}
