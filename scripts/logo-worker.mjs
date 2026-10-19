// Run explicitly from the reviewed repository root with:
// node --conditions=react-server --import tsx scripts/logo-worker.mjs [--disabled | [--check] --config /approved/root/.local-fluid/logo-worker.json [--storage-identity /approved/root/.local-fluid/logo-storage-identity.json]]
// Do not add this entrypoint to the web, text or local-development launchers.
const args = process.argv.slice(2);
const checkOnly = args[0] === "--check";
const selected = checkOnly ? args.slice(1) : args;
const disabled = () => console.info(JSON.stringify({ event: "logo_worker_disabled" }));
const unavailable = () => { console.error(JSON.stringify({ event: "logo_worker_unavailable" })); process.exitCode = 2; };
if (args.length === 0 || args.length === 1 && args[0] === "--disabled") {
  // No host/config module, secret discovery, file read, pool or timer.
  disabled();
} else if ((selected.length === 2 || selected.length === 4 && selected[2] === "--storage-identity" && selected[3])
  && selected[0] === "--config" && selected[1]) {
  let session;
  try {
    const { readProtectedLogoDedicatedConfiguration } = await import("../worker/logo-dedicated-config.ts");
    if (selected.length === 4) {
      const { readLocalLogoStorageConfiguration } = await import("../worker/logo-local-storage-session.ts");
      session = await readLocalLogoStorageConfiguration(selected[1], selected[3]);
    }
    const configuration = session?.configuration ?? await readProtectedLogoDedicatedConfiguration(selected[1]);
    if (configuration.status === "disabled") disabled();
    else if (configuration.status !== "configured") unavailable();
    else {
      const { runLogoDedicatedWorker } = await import("../worker/logo-dedicated-launcher.ts");
      const result = await runLogoDedicatedWorker(configuration, undefined, { checkOnly, storageTokenProvider: session?.tokenProvider });
      process.exitCode = result.exitCode;
      // Keep renewal available if shutdown could not prove all work drained.
      if (result.status !== "drain_unconfirmed" && result.status !== "disposal_unconfirmed") await session?.close();
    }
  } catch { await session?.close().catch(() => {}); unavailable(); }
} else unavailable();
