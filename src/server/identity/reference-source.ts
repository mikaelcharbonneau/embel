import "server-only";
import type { IdentityReferenceQuery, ReferenceSourceResult } from "@/domain/identity-references";
import type { AuthenticatedContext } from "../auth/context";

/** The DAL first verifies the owned project. A configured source then establishes real owned media and attribution. */
interface ReferenceSource {
  list(auth: AuthenticatedContext, projectId: string, query: IdentityReferenceQuery): Promise<ReferenceSourceResult>;
}

/** No source is configured. URL attribution, fixture files and ambient credentials never activate a feed. */
export const defaultReferenceSource: ReferenceSource = Object.freeze({
  async list(): Promise<ReferenceSourceResult> {
    return { status: "unavailable", reason: "reference_source_unconfigured" };
  },
});
