"use client";

/** TEST ONLY. Import from a test harness, never an application route. No network or storage. */
import { useState } from "react";
import { LogoBriefFields } from "../../src/components/logo-creation/brief-form";
import { seedLogoBrief } from "../../src/components/logo-creation/brief-model";
import { LogoReferencePickerView } from "../../src/components/logo-creation/reference-picker";
import { LogoConceptGridView } from "../../src/components/logo-creation/concept-grid";
import { LogoCostConfirmationView } from "../../src/components/logo-creation/cost-confirmation";
import type { LogoBriefDraft, LogoConceptSource, LogoReferenceSelection } from "../../src/domain/logo-workspace";
import type { LogoCostQuote, LogoQuoteRequest } from "../../src/domain/logo-jobs";
import { LOGO_TEST_FIXTURE_LABEL, syntheticLogoBatch, syntheticLogoBrief, syntheticLogoContext, syntheticLogoQuote, syntheticLogoReferences } from "./logo-creation";

export function LogoCreationFixturePreview({ scenario }: { scenario: "blank" | "partial" | "uncertain" }) {
  const [draft, setDraft] = useState<LogoBriefDraft>(() => scenario === "blank" ? {
    name: "", activity: "", audience: "", personality: "", logoTypes: [],
  } : syntheticLogoBrief());
  const [references] = useState(() => scenario === "blank" ? [] : syntheticLogoReferences());
  const [batch] = useState(() => scenario === "blank" ? null : scenario === "uncertain" ?
    syntheticLogoBatch(["succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "needs_reconciliation"]) : syntheticLogoBatch());
  const [selections, setSelections] = useState<LogoReferenceSelection[]>([]);
  const [selected, setSelected] = useState<LogoConceptSource | null>(null);
  const [quote, setQuote] = useState<LogoCostQuote | null>(null);
  const [nameConflict, setNameConflict] = useState(false);
  const [sourceProjectRevision, setSourceProjectRevision] = useState<number>();
  const [notice, setNotice] = useState("");
  const editBrief = (next: LogoBriefDraft) => { setDraft(next); setQuote(null); };
  const showFixtureQuote = (request: LogoQuoteRequest, targetSlotIds: string[], conceptPlan: LogoCostQuote["conceptPlan"]) => {
    setQuote({ ...syntheticLogoQuote(), request, targetSlotIds, conceptPlan });
    setNotice(`Test fixture: ${request.operation.replaceAll("_", " ")} cost review requested. No request was sent.`);
  };
  return <main aria-label="Test-only logo creation preview" style={{ maxWidth: 1120, margin: "0 auto", padding: 20 }}>
    <h1>Logo creation</h1>
    <p role="note">{LOGO_TEST_FIXTURE_LABEL} All sample records, permission records and estimates below are synthetic.</p>
    <LogoBriefFields draft={draft} onChange={editBrief} nameConflict={nameConflict} sourceProjectRevision={sourceProjectRevision} onReuseStrategy={() => {
      const seeded = seedLogoBrief(syntheticLogoContext());
      editBrief({ ...seeded.draft, logoTypes: draft.logoTypes });
      setNameConflict(seeded.nameConflict);
      setSourceProjectRevision(1);
    }} />
    <LogoReferencePickerView references={references} selections={selections} onChange={next => { setSelections(next); setQuote(null); }} />
    <LogoConceptGridView batch={batch} selected={selected} generation={{ status: "available" }} onSelect={source => {
      const changed = !selected || source.batchId !== selected.batchId || source.slotId !== selected.slotId || source.attemptId !== selected.attemptId;
      setSelected(source);
      if (changed) {
        setQuote(null);
        setNotice("Test fixture: a concept is selected for review. No selection was saved.");
      }
    }} onRequestConcepts={() => {
      const fixture = syntheticLogoQuote();
      showFixtureQuote(fixture.request, fixture.targetSlotIds, fixture.conceptPlan);
    }} onRequestMore={() => {
      const fixture = syntheticLogoQuote();
      showFixtureQuote({ operation: "more_concepts", expected: fixture.expected, briefRevisionId: batch!.briefRevisionId, referenceSnapshotId: batch!.referenceSnapshotId }, fixture.targetSlotIds, fixture.conceptPlan);
    }} onRequestRefine={source => {
      const fixture = syntheticLogoQuote();
      showFixtureQuote({ operation: "refine_preview", expected: fixture.expected, source, instruction: "Test fixture refinement" }, [source.slotId], null);
    }} onRequestRetryFailed={failedSlotIds => {
      const fixture = syntheticLogoQuote();
      showFixtureQuote({ operation: "retry_failed", expected: fixture.expected, sourceBatchId: batch!.id, failedSlotIds }, failedSlotIds, null);
    }} onCheckRequest={batch ? () => { setNotice("Test fixture: check requested for the existing request. No request was sent."); } : undefined} />
    {notice && <p role="status" aria-live="polite">{notice}</p>}
    <LogoCostConfirmationView quote={quote} batch={batch} />
  </main>;
}
