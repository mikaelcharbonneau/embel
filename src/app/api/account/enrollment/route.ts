import { ensureAccountEnrollmentSchema } from "@/domain/account-enrollment";
import { getAuthenticatedContext } from "@/server/auth/context";
import { ensureAccountServiceEnrollment, readAccountServiceEnrollment } from "@/server/data/account-enrollment";
import { ApiError, errorResponse, privateJson } from "@/server/http/errors";
import { assertExpectedAccount } from "@/server/http/account-fence";
import { assertMutationOrigin, readJson } from "@/server/http/request";
import { isSharedWorkerRuntime } from "@/server/shared-account/routing";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    if (new URL(request.url).search) throw new ApiError("invalid_input");
    const auth = await getAuthenticatedContext();
    assertExpectedAccount(request, auth.userId);
    if (isSharedWorkerRuntime()) return privateJson({ enrollment: null });
    return privateJson({ enrollment: await readAccountServiceEnrollment(auth, request.signal) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    assertMutationOrigin(request);
    if (new URL(request.url).search) throw new ApiError("invalid_input");
    await readJson(request, ensureAccountEnrollmentSchema, 1024);
    const auth = await getAuthenticatedContext();
    assertExpectedAccount(request, auth.userId);
    if (isSharedWorkerRuntime()) return privateJson({ enrollment: null });
    return privateJson({ enrollment: await ensureAccountServiceEnrollment(auth, request.signal) });
  } catch (error) { return errorResponse(error); }
}
