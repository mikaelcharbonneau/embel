export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startLogoWebServices } = await import("./server/runtime/logo-web-bootstrap");
    startLogoWebServices(process.env);
  }
}
