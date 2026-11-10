import type {
  ScreeningBasis,
  ScreeningOverview,
  ScreeningRecord,
  ScreeningRecordInput,
} from "@/domain/project-screening";
export const screeningOwner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const screeningProject = "11111111-1111-4111-8111-111111111111";
export const screeningSelection = "22222222-2222-4222-8222-222222222222";
export const screeningBasis: ScreeningBasis = {
  ownerId: screeningOwner,
  projectId: screeningProject,
  selectionId: screeningSelection,
  candidateId: "33333333-3333-4333-8333-333333333333",
  projectRevision: 2,
  contextHash: "a".repeat(64),
  name: "Cedar",
};
export const screeningInput: ScreeningRecordInput = {
  selectionId: screeningSelection,
  expectedProjectRevision: 2,
  requestId: "44444444-4444-4444-8444-444444444444",
  criteria: { tool: "domains", domain: "cedar.com" },
  notes: "Explicit local fixture. No availability is established.",
  sourceUrls: ["https://example.com/registry"],
  observedAt: "2026-10-12T12:00:00Z",
  acknowledged: true,
};
export const screeningRecord: ScreeningRecord = {
  id: "55555555-5555-4555-8555-555555555555",
  requestId: screeningInput.requestId,
  basis: screeningBasis,
  criteria: screeningInput.criteria,
  provenance: "user_recorded",
  verification: "unverified",
  legalClearance: "not_assessed",
  notes: screeningInput.notes,
  sourceUrls: screeningInput.sourceUrls,
  observedAt: screeningInput.observedAt,
  recordedAt: "2026-10-12T12:01:00Z",
};
export const screeningPage: ScreeningOverview = {
  ownerId: screeningOwner,
  projectId: screeningProject,
  projectRevision: 2,
  currentBasis: screeningBasis,
  records: [],
  nextCursor: null,
};
