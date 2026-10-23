import { readFile } from "node:fs/promises";

// Read-only operator check. This script cannot deploy, scale, enable a pilot,
// access credentials, or infer that a READY build has a healthy worker.
try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--receipt" || args[2] !== "--deployment") throw new Error();
  const receipt = JSON.parse(await readFile(args[1], "utf8"));
  const deployment = JSON.parse(await readFile(args[3], "utf8"));
  if (!/^[a-f0-9]{40}$/u.test(receipt.sourceRevision ?? "")
    || !/^[a-f0-9]{64}$/u.test(receipt.bundleSha256 ?? "")
    || !/^prj_[A-Za-z0-9]{10,100}$/u.test(receipt.projectId ?? "")
    || receipt.projectId === "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt"
    || !["standby", "active"].includes(receipt.mode)) throw new Error();
  const expected = { githubDeployment: "1", githubOrg: "mikaelcharbonneau", githubRepo: "embel",
    githubCommitRef: "main", githubCommitSha: receipt.sourceRevision };
  if (!/^dpl_[A-Za-z0-9]{10,100}$/u.test(deployment.id ?? "")
    || (deployment.projectId ?? deployment.project?.id) !== receipt.projectId
    || deployment.target !== "production" || (deployment.readyState ?? deployment.state) !== "READY"
    || Object.entries(expected).some(([key, value]) => receipt.deploymentMetadata?.[key] !== value || deployment.meta?.[key] !== value)) throw new Error();
  console.log(JSON.stringify({ event: "naming_deployment_provenance_verified", deploymentId: deployment.id,
    projectId: receipt.projectId, sourceRevision: receipt.sourceRevision, expectedBundleSha256: receipt.bundleSha256,
    mode: receipt.mode, workerReadinessVerified: false }));
} catch {
  // Never echo input documents, parser messages, paths or attached error causes.
  console.error("Naming deployment provenance could not be verified. Keep instances stopped and inspect the public release metadata.");
  process.exitCode = 1;
}
