/** A paid continuation was refused because its control-plane authority is
 * unavailable. This is not evidence that the provider cancelled the session. */
export class NamingContinuationUnavailableError extends Error {
  constructor(message = "naming_continuation_unavailable") { super(message); this.name = "NamingContinuationUnavailableError"; }
}
