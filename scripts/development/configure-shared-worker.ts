import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeSharedDevelopmentConfiguration } from "./shared-configuration";

const root = fileURLToPath(new URL("../../", import.meta.url));
try {
  // Dynamic imports keep the existing JS development helpers in one authority.
  const secretsModule = path.join(root, "scripts/development/secrets.mjs");
  const schemaModule = path.join(root, "scripts/development/shared-schema-install.mjs");
  const { developmentProviderKey } = await import(secretsModule);
  const { installDevelopmentPolicies } = await import(schemaModule);
  const apiKey = await developmentProviderKey(root);
  if (!apiKey) throw Error("missing dedicated credential");
  const configuration = await composeSharedDevelopmentConfiguration({ root, apiKey });
  await installDevelopmentPolicies(configuration, root);
  console.log("Development model access verified and shared policies installed.");
} catch { console.error("Development worker configuration failed; private details withheld."); process.exitCode = 1; }
