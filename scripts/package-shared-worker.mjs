import { fileURLToPath } from "node:url";
import { prepareSharedWorkerRelease } from "../services/shared-worker/package-release.mjs";
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--project" || args[2] !== "--mode") throw Error("Use --project <existing-worker-project-id> --mode stopped|active");
const result = await prepareSharedWorkerRelease({ root: fileURLToPath(new URL("../", import.meta.url)), projectId: args[1], mode: args[3] });
process.stdout.write(JSON.stringify(result) + "\n");
