// Production dependency audit, run in CI in place of a bare `npm audit --omit=dev`:
//
//   node scripts/ci/audit-production.mjs
//
// It runs `npm audit --omit=dev --json` and fails on every advisory except the ones listed in
// ACCEPTED below. npm has no built-in way to accept one advisory, so this keeps the exception
// narrow: an entry names one advisory and the packages it may appear through, and it carries an
// expiry date after which it fails again and must be reviewed.
//
// Exit status 1 and one line per finding when anything fails.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export const ACCEPTED = [
  {
    // picomatch ReDoS through single-branch repeated extglobs. Every published picomatch
    // (<= 4.0.7) is affected and no fixed release exists yet (checked November 18, 2026).
    // It reaches production dependencies only through the `workflow` package's build and
    // tooling side: @workflow/cli (tinyglobby, fdir) and @workflow/nuxt (@nuxt/kit, unctx,
    // unplugin). Embel never passes user-supplied glob patterns to it, which is what the
    // attack needs. Upgrade picomatch (or workflow) and remove this entry once a fix ships.
    advisory: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
    package: "picomatch",
    expires: "2026-12-31",
  },
];

/** Returns one finding string per advisory in `report` that ACCEPTED does not cover. */
export function findUnacceptedAdvisories(report, accepted = ACCEPTED, today = new Date()) {
  const findings = [];
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      // String entries point at another vulnerable package; that package's own entry carries
      // the advisory, so only object entries need a decision.
      if (typeof via !== "object" || via === null) continue;
      const entry = accepted.find((item) => item.advisory === via.url && item.package === name);
      if (entry && new Date(`${entry.expires}T23:59:59Z`) >= today) continue;
      const reason = entry ? ` (accepted until ${entry.expires}, now expired)` : "";
      findings.push(`${name} ${via.severity}: ${via.title} ${via.url}${reason}`);
    }
  }
  return findings;
}

async function main() {
  let stdout;
  try {
    ({ stdout } = await run("npm", ["audit", "--omit=dev", "--json"], {
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (error) {
    // npm audit exits 1 when it finds anything; the JSON report is still on stdout.
    if (typeof error.stdout !== "string" || error.stdout === "") throw error;
    stdout = error.stdout;
  }
  const report = JSON.parse(stdout);
  if (report.error) throw new Error(`npm audit failed: ${JSON.stringify(report.error)}`);

  const findings = findUnacceptedAdvisories(report);
  const total = report.metadata?.vulnerabilities?.total ?? 0;
  if (findings.length > 0) {
    for (const finding of findings) console.error(finding);
    process.exitCode = 1;
    return;
  }
  console.log(
    total === 0
      ? "No known vulnerabilities in production dependencies."
      : `Only accepted advisories remain (${total} affected packages): ${ACCEPTED.map((item) => item.advisory).join(", ")}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
