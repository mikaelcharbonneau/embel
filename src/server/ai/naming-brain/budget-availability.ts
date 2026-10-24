import "server-only";

/** The deployed Agents endpoint rejected spend_control. SDK types and budget
 * reservations do not establish provider enforcement. Re-enable only through a
 * reviewed implementation with a proven aggregate bound, never an env opt-out.
 * Observation and cancellation of issued sessions remain available. */
export function isNamingProviderBudgetAvailable(): boolean { return false; }

export const NAMING_BUDGET_UNAVAILABLE = "provider_budget_control_unavailable";
export const NAMING_BUDGET_UNAVAILABLE_MESSAGE = "AI naming is unavailable because the provider's required spending limit is not supported. The integration needs an update before generation can start. Your saved names and choices remain available.";
