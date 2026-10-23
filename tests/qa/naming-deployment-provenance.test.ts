import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
const folders: string[] = [];
const projectId = "prj_syntheticNamingDeployment123", sourceRevision = "a".repeat(40), bundleSha256 = "b".repeat(64);
const meta = { githubDeployment: "1", githubOrg: "mikaelcharbonneau", githubRepo: "embel", githubCommitRef: "main", githubCommitSha: sourceRevision };
const receipt = { projectId, sourceRevision, bundleSha256, mode: "standby", deploymentMetadata: meta };
const deployment = { id: "dpl_syntheticNamingDeployment123", projectId, target: "production", readyState: "READY", meta };
function check(saved: unknown = receipt, remote: unknown = deployment) {
  const folder = mkdtempSync(path.join(tmpdir(), "embel-provenance-")); folders.push(folder);
  const first = path.join(folder, "receipt.json"), second = path.join(folder, "deployment.json");
  writeFileSync(first, JSON.stringify(saved)); writeFileSync(second, JSON.stringify(remote));
  return spawnSync(process.execPath, ["scripts/verify-naming-deployment.mjs", "--receipt", first, "--deployment", second], { encoding: "utf8", timeout: 10000 });
}
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
it("verifies matching public provenance but never claims worker readiness", () => {
  const result = check(); expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ event: "naming_deployment_provenance_verified", deploymentId: deployment.id, projectId, sourceRevision, expectedBundleSha256: bundleSha256, mode: "standby", workerReadinessVerified: false });
  expect(check({ ...receipt, mode: "active" }, { ...deployment, projectId: undefined, project: { id: projectId } }).status).toBe(0);
});
it.each([
  { meta: {} }, { meta: { ...meta, githubCommitSha: "c".repeat(40) } }, { meta: { ...meta, githubCommitRef: "feature" } },
  { meta: { ...meta, githubOrg: "another-owner" } }, { meta: { ...meta, githubRepo: "another-repo" } },
  { meta: { ...meta, githubDeployment: undefined } }, { projectId: "prj_anotherProject123" },
  { target: "preview" }, { readyState: "BUILDING" }, { id: "not-a-deployment" },
])("rejects a missing or mismatched deployment binding: %j", changes => {
  const result = check(receipt, { ...deployment, ...changes }); expect(result.status).toBe(1); expect(result.stdout).toBe("");
});
it.each([{ sourceRevision: "bad" }, { bundleSha256: "bad" }, { projectId: "prj_WKrFUPy3wptZ3qI9l1hTuqPmzkDt" }, { mode: "stopped" }, { deploymentMetadata: {} }])("rejects unverified receipt fields: %j", changes => {
  expect(check({ ...receipt, ...changes }).status).toBe(1);
});
it("does not echo sensitive-looking untrusted input or parser failures", () => {
  const secret = "synthetic-secret-not-for-output";
  for (const value of [null, secret, { ...deployment, meta: { githubCommitSha: secret } }]) {
    const result = check(receipt, value); expect(result.status).toBe(1); expect(result.stdout + result.stderr).not.toContain(secret);
  }
});
