export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { sharedAccountHttpConfigured, startSharedAccountHttpServices } = await import("./server/shared-account/bootstrap");
    if (sharedAccountHttpConfigured(process.env)) {
      startSharedAccountHttpServices(process.env);
      return;
    }
    const { startAccountHttpBindingSource } = await import("./server/runtime/account-http-binding-source");
    startAccountHttpBindingSource(process.env);
    const { startAccountHttpServices } = await import("./server/runtime/account-http-services");
    if (process.env.EMBEL_ACCOUNT_HTTP_SOURCE_ENABLED !== "true") startAccountHttpServices(process.env);
    const { startLogoWebServices } = await import("./server/runtime/logo-web-bootstrap");
    startLogoWebServices(process.env);
  }
}
