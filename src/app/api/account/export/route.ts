import { startAccountExport } from "@/server/account/export";
import { assertExpectedAccount } from "@/server/http/account-fence";
import { ApiError, errorResponse } from "@/server/http/errors";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { z } from "zod";

export const dynamic = "force-dynamic";
// The ZIP streams while it is built; files make up most of the time.
export const maxDuration = 300;

/** "Download my data" for the signed-in account. POST, because each download
 * counts against the account's daily limit. */
export async function POST(request: Request) {
  try {
    assertMutationOrigin(request);
    if (new URL(request.url).search) throw new ApiError("invalid_input");
    await readJson(request, z.strictObject({}), 1024);
    const { auth, open } = await startAccountExport(request.signal);
    assertExpectedAccount(request, auth.userId);
    const body = await open();
    const day = new Date().toISOString().slice(0, 10);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="embel-data-${day}.zip"`,
        "Cache-Control": "private, no-store",
        "Vary": "Cookie",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) { return errorResponse(error); }
}
