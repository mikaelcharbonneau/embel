import "server-only";
import { enrollmentStatusSchema, type EnrollmentStatus } from "@/domain/account-enrollment";
import type { AuthenticatedContext } from "@/server/auth/context";
import { ApiError } from "@/server/http/errors";

async function enrollment(auth: AuthenticatedContext, name: "ensure_account_service_enrollment" | "get_account_service_enrollment", signal?: AbortSignal): Promise<EnrollmentStatus | null> {
  if (signal?.aborted) throw new ApiError("integration_unavailable");
  let result;
  try { result = await auth.client.rpc(name); }
  catch { throw new ApiError("integration_unavailable"); }
  if (signal?.aborted) throw new ApiError("integration_unavailable");
  if (result.error) throw new ApiError(result.error.code === "42501" && result.error.message === "account_enrollment_unauthenticated"
    ? "unauthenticated" : "integration_unavailable");
  if (result.data === null && name === "get_account_service_enrollment") return null;
  const parsed = enrollmentStatusSchema.safeParse(result.data);
  if (!parsed.success) throw new ApiError("integration_unavailable");
  if (parsed.data.ownerId !== auth.userId.toLowerCase()) throw new ApiError("not_found");
  return parsed.data;
}
export async function readAccountServiceEnrollment(auth: AuthenticatedContext, signal?: AbortSignal) {
  return enrollment(auth, "get_account_service_enrollment", signal);
}
export async function ensureAccountServiceEnrollment(auth: AuthenticatedContext, signal?: AbortSignal): Promise<EnrollmentStatus> {
  const result = await enrollment(auth, "ensure_account_service_enrollment", signal);
  if (!result) throw new ApiError("integration_unavailable");
  return result;
}
