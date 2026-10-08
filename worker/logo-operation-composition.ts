import { createLogoVectorProposalHandler, type LogoVectorProposalHandlerDependencies } from "./handlers/logo-vector-proposals";
import type { HandlerRegistry, JobHandler } from "./runner";
import { createLogoConceptHandler, type LogoConceptHandlerDependencies } from "./handlers/logo-concepts";
import { createLogoRefinementHandler, type LogoRefinementHandlerDependencies } from "./handlers/logo-refinements";
import { createLogoVectorHandler, type LogoVectorHandlerDependencies } from "./logo-vector/handler";
import { createLogoDirectionsHandler, type LogoDirectionsDependencies } from "./handlers/logo-directions";
import { createLogoExportsHandler, type LogoExportsDependencies } from "./handlers/logo-exports";

export type LogoOperation = "identity.logo_concept" | "identity.logo_refine" | "identity.logo_vectorize" | "identity.logo_directions" | "identity.logo_export" | "identity.logo_vector_propose";
export type LogoOperationCompositionInput = {
  concepts: LogoConceptHandlerDependencies | null;
  refinements: LogoRefinementHandlerDependencies | null;
  vector: LogoVectorHandlerDependencies | null;
  directions: LogoDirectionsDependencies | null;
  exports: LogoExportsDependencies | null;
  proposals?: LogoVectorProposalHandlerDependencies | null;
  unavailableReasons: Partial<Record<LogoOperation, string>>;
};
export type LogoOperationComposition = {
  handlers: HandlerRegistry;
  capabilities: Record<LogoOperation, { status: "available" } | { status: "unavailable"; reason: string }>;
};

/** Composition performs no environment lookup, provider probe or dispatch.
 * The trusted caller supplies reviewed adapters. Admission and worker readiness
 * must still independently verify the exact persisted operation policy. */
export function createLogoOperationComposition(input: LogoOperationCompositionInput): LogoOperationComposition {
  const handlers = new Map<string, JobHandler>();
  const capabilities = {} as LogoOperationComposition["capabilities"];
  function register<T>(operation: LogoOperation, dependencies: T | null, create: (dependencies: T) => JobHandler): void {
    const reason = input.unavailableReasons[operation]?.trim() || "Required logo runtime dependencies are not configured.";
    if (dependencies === null) { capabilities[operation] = { status: "unavailable", reason }; return; }
    try {
      const handler = create(dependencies);
      handlers.set(operation, handler);
      capabilities[operation] = { status: "available" };
    } catch {
      capabilities[operation] = { status: "unavailable", reason: "The configured logo runtime could not be initialized." };
    }
  }
  register("identity.logo_concept", input.concepts, createLogoConceptHandler);
  register("identity.logo_refine", input.refinements, createLogoRefinementHandler);
  register("identity.logo_vectorize", input.vector, createLogoVectorHandler);
  register("identity.logo_directions", input.directions, createLogoDirectionsHandler);
  register("identity.logo_export", input.exports, createLogoExportsHandler);
  register("identity.logo_vector_propose", input.proposals ?? null, createLogoVectorProposalHandler);
  return { handlers, capabilities };
}
