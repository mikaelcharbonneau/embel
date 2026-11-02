import path from "node:path";
import { privateDirectory, writeState } from "./config.mjs";

/** Optional compatibility for exact loopback probes; does not disable health checks. */
export async function prepareProxyHealth(root, state, docker) {
  const definitions = [
    { dockerfile: "Auth.Dockerfile", local: "embel-dev/auth-health:2.122.0", image: "supabase/gotrue:v2.197.0-embel-dev-health", pin: "gotrue-version", version: "v2.197.0-embel-dev-health" },
    { dockerfile: "Storage.Dockerfile", local: "embel-dev/storage-health:2.122.0", image: "supabase/storage-api:v1.84.19-embel-dev-health", pin: "storage-version", version: "v1.84.19-embel-dev-health" },
  ];
  const context = path.join(root, "config/development/health");
  const pins = path.join(state, "supabase/.temp");
  await privateDirectory(pins);
  for (const entry of definitions) {
    await docker(["build", "--network=none", "-f", path.join(context, entry.dockerfile), "-t", entry.local, context]);
    for (const registry of ["", "public.ecr.aws/", "ghcr.io/"]) await docker(["tag", entry.local, registry + entry.image]);
    await writeState(path.join(pins, entry.pin), entry.version + "\n");
  }
}
