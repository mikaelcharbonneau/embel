// Run explicitly from the reviewed repository root with:
// node --conditions=react-server --import tsx scripts/logo-worker.mjs [--disabled | --config /approved/root/.local-fluid/logo-worker.json]
// Do not add this entrypoint to the web, text or local-development launchers.
const args = process.argv.slice(2);
const disabled = () => console.info(JSON.stringify({ event: "logo_worker_disabled" }));
const unavailable = () => { console.error(JSON.stringify({ event: "logo_worker_unavailable" })); process.exitCode = 2; };
if (args.length === 0 || args.length === 1 && args[0] === "--disabled") {
  // No host/config module, secret discovery, file read, pool or timer.
  disabled();
} else if (args.length === 2 && args[0] === "--config" && args[1]) {
  try {
    const { readProtectedLogoDedicatedConfiguration } = await import("../worker/logo-dedicated-config.ts");
    const configuration = await readProtectedLogoDedicatedConfiguration(args[1]);
    if (configuration.status === "disabled") disabled();
    else if (configuration.status !== "configured") unavailable();
    else {
      const { runLogoDedicatedWorker } = await import("../worker/logo-dedicated-launcher.ts");
      process.exitCode = (await runLogoDedicatedWorker(configuration)).exitCode;
    }
  } catch { unavailable(); }
} else unavailable();
