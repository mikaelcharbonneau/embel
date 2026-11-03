// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrainstormCoverage } from "@/components/naming/brainstorm-coverage";
import { namingBrainRunSummarySchema, namingFeedEntrySchema } from "@/domain/naming-brain";
import { initialNamingPreferencesV2, type NamingApproach } from "@/domain/naming-brain-preferences";
import { NAMING_BRAINSTORM_CAUTION } from "@/domain/naming-brainstorm";
import { contextSnapshotSchema } from "@/domain/projects";
import { nameIdentityKey, namingPreferenceRevisionSchema, namingStrategyBasis, namingStrategyKey } from "@/domain/project-naming";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ownerId = id(1), projectId = id(2), time = "2026-11-03T12:00:00Z";
const context = contextSnapshotSchema.parse({ description: "Synthetic naming coverage fixture" });
const saved = namingPreferenceRevisionSchema.parse({ ownerId, projectId, version: 2, createdAt: time, preferences: {
  ...initialNamingPreferencesV2(context), approaches: ["invented", "real_words", "compounds"], directness: "all",
} });
const run = namingBrainRunSummarySchema.parse({ version: 1, ownerId, projectId, runId: id(3), jobId: id(4), batchId: id(5),
  generationProfile: "brainstorm_v1", revision: 1, resumedFromRunId: null, state: "partial", projectRevision: 1,
  preferencesVersion: saved.version, feedbackRevision: 0, steeringRevision: 0, demandSequence: 1,
  snapshotHash: "a".repeat(64), acceptedPolicyIdentity: "b".repeat(64), progress: 2, preparedSetId: null,
  fulfillment: { status: "partial", targetCount: 100, acceptedCount: 2, missingCount: 98, coverageSatisfied: false, message: "Partial fixture" },
  accounting: { status: "held_unsettled", heldAllowanceMicrousd: 5_000_000, confirmedActualCostMicrousd: null }, createdAt: time, updatedAt: time });
function row(n: number, primaryApproach: NamingApproach, runId = run.runId) {
  const candidateId = id(n + 100), value = `Synthetic ${n}`;
  return namingFeedEntrySchema.parse({ entryId: id(n + 200), position: n, runId, steeringRevision: 0,
    primaryApproach, additionalApproaches: [], publishedClaims: [], entry: {
      candidate: { id: candidateId, ownerId, projectId, value, identityKey: nameIdentityKey(value), contextRevision: 1,
        rationale: "Synthetic suggestion", caution: NAMING_BRAINSTORM_CAUTION, verificationNotes: [],
        strategyBasis: namingStrategyBasis(context), strategyKey: namingStrategyKey(context), createdAt: time,
        origin: { kind: "brainstorm", version: 1, profile: "brainstorm_v1", ownerId, projectId, candidateId, contextRevision: 1, value,
          batchId: run.batchId, jobId: run.jobId, runId, callId: id(6), responseId: "resp_fixture", requestId: null, model: "fixture", generatedAt: time } },
      retention: { ownerId, projectId, candidateId, revision: 0, favorite: false, saved: false, updatedAt: null },
    } });
}
const first = row(1, "invented"), second = row(2, "invented"), old = row(3, "real_words", id(1000));
describe("requested approaches in a saved brainstorm", () => {
  it("shows real zeroes even for partial generation once the whole saved membership is loaded", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<BrainstormCoverage run={run} entries={[first, second, old]} saved={saved} />);
    expect(host.querySelector("button")?.textContent).toContain("1 of 3 approaches represented");
    expect([...host.querySelectorAll("tbody tr")].map(tr => [...tr.children].map(cell => cell.textContent))).toEqual([
      ["Invented words", "2"], ["Real words", "0"], ["Compounds", "0"],
    ]);
  });
  it("does not infer absence from an incomplete page, repeated name, different preference revision or legacy run", () => {
    expect(renderToStaticMarkup(<BrainstormCoverage run={run} entries={[old, first]} saved={saved} />)).toBe("");
    expect(renderToStaticMarkup(<BrainstormCoverage run={run} entries={[first, first]} saved={saved} />)).toBe("");
    expect(renderToStaticMarkup(<BrainstormCoverage run={run} entries={[first, second]} saved={{ ...saved, version: 3 }} />)).toBe("");
    expect(renderToStaticMarkup(<BrainstormCoverage run={{ ...run, generationProfile: undefined }} entries={[first, second]} saved={saved} />)).toBe("");
  });
});
