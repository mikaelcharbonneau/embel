import "server-only";
import type { IdentityTransactionConnection } from "@/server/data/identity-transaction";
import { ApiError } from "@/server/http/errors";
import { qualifySharedStoragePolicies } from "../runtime/shared-storage-policy-qualification";
export {
  sharedCustomerStorageHelperHash,
  sharedLegacyStorageHelperHash,
} from "../runtime/shared-storage-policy-qualification";

/** A valid fixed web login must not qualify against an older packet whose
 * ordinary customer JWT still bypasses ban/session revocation at Storage. */
export async function qualifySharedCustomerStoragePolicy(connection: IdentityTransactionConnection): Promise<void> {
  try {
    await qualifySharedStoragePolicies(connection);
  } catch {
    throw new ApiError("integration_unavailable");
  }
}
