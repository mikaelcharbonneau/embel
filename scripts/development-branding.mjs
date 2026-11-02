#!/usr/bin/env node
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DevelopmentError, repositoryRoot } from "./development/config.mjs";
import { prepareSharedRuntime, preflightSharedRuntime, startSharedRuntime, stopSharedRuntime } from "./development/shared-runtime.mjs";
import { developmentProviderKey } from "./development/secrets.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length && args[0] !== "--build-only") throw new DevelopmentError("Use npm run dev:branding [-- --build-only].");
  console.log("Building the same shared worker engine in its pinned Linux runtime and checking native operations.");
  const prepared = await prepareSharedRuntime(repositoryRoot);
  if (args[0] === "--build-only") console.log(JSON.stringify({ built: true, native: prepared.native, providerCalls: false }, null, 2));
  else {
    if (!await developmentProviderKey(repositoryRoot)) throw new DevelopmentError("The worker build is ready. Configure the dedicated development provider key in .embel-dev/provider.env, then rerun npm run dev:branding. No AI requests were made.");
    await stopSharedRuntime(repositoryRoot);
    const execute = promisify(execFile);
    // The child reads the private file itself; no secret is passed in argv.
    try { await execute(process.execPath, ["--conditions=react-server", "--import", "tsx", path.join(repositoryRoot, "scripts/development/configure-shared-worker.ts")], { cwd: repositoryRoot, timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true }); }
    catch { throw new DevelopmentError("Worker configuration failed. Check dedicated provider access, local services and the selected models; private details withheld."); }
    const preflight = await preflightSharedRuntime(repositoryRoot);
    const started = await startSharedRuntime(repositoryRoot);
    if (!started.ready) throw new DevelopmentError("The shared worker did not qualify all three lanes. Run npm run dev:doctor; setup is not ready for generation.");
    console.log(JSON.stringify({ preflight, ...started }, null, 2));
  }
} catch (error) { console.error(error instanceof DevelopmentError ? error.message : "Development worker setup failed; private details withheld."); process.exitCode = 1; }
