import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeSharedDevelopmentConfiguration } from "./shared-configuration";
import { namingPreferencesRuntimeFingerprint } from "../../worker/naming-brain-configuration";

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
  // Preferences must be attested by the packaged Linux Node runtime, not
  // by the host Node version that installs the development policies.
  const { node, icu, unicode } = configuration.artifact.runtime;
  const namingFingerprint = { ...namingPreferencesRuntimeFingerprint(), nodeVersion: node, icuVersion: icu, unicodeVersion: unicode };
  await installDevelopmentPolicies(configuration, root, namingFingerprint);
  console.log("Development model access verified and shared policies installed.");
} catch { console.error("Development worker configuration failed; private details withheld."); process.exitCode = 1; }
