/** Two explicit worker opt-ins are required. SQL separately freezes the
 * background profile only for new admissions to the qualified deployment. */
export function apiTextBackgroundRecoveryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FLUID_API_TEXT_MULTI_ACCOUNT_ENABLED === "true" && env.FLUID_API_TEXT_BACKGROUND_RECOVERY_ENABLED === "true";
}
