-- REVIEW-ONLY, NOT APPLIED. Requires a separate operator policy decision.
-- The operator acknowledges that this response is unusable and that provider
-- billing remains unresolved. The retained diagnostics show a completed envelope with an unfinished search.
-- The first competitor depends on unfinished-search evidence; the original
-- envelope is unavailable. No successful research or final bill is asserted.
-- Install the paired candidate only after review. This statement changes only
-- the one job's state/error/finished_at and appends its immutable receipt.
-- All original evidence and the entire remaining 15,811,481-microdollar hold stay.
-- Replace the deliberately invalid decision-reference placeholder only after
-- an actual external operator decision exists. SQL records that attestation;
-- it cannot independently verify the external authorization.
begin;
insert into fluid_private.api_text_operator_adjudications(
 job_id,owner_id,project_id,step_id,output_sha256,source_revision,source_adapter_sha256,
 terminal_evidence,decision,operator_decision_reference,reason,reserved_microusd,observed_microusd,retained_microusd)
values(
 '5f31a4ff-f747-4464-bc79-64b757fe5df3','6840f4c2-15a6-45a7-97be-41e7e5e37f42',
 '4da54b89-43b8-4da6-a092-ce6113fd3916','a4794328-be5e-4c7e-a6b0-9a6f007e0f05',
 '2182808eb117289a1e340943063c4033fbaef6ff534c030965a20578353e3a6c',
 '4c0bbf362e8c85132f9d5068ec25dc771ef5cd5b','d37e4c528334e7099d042d835d2cebc75cc06d214c2b52deb3299e38441888a9',
 'reviewed_source_branch_order_provider_unexpected_output_after_completed',
 'abandon_unusable_result_billing_unresolved',
 'REPLACE_APPROVED_OPERATOR_DECISION_REFERENCE',
 'Operator abandons this unusable completed research response. The retained first competitor lacks completed-search provenance, and the full original envelope is unavailable. Complete provider billing and tool compliance remain unresolved. Original ambiguous evidence and the full remaining reservation are retained; no refund, final-cost assertion, publication, or automatic retry is authorized by this receipt.',
 15892880,81399,15811481);
do $readback$
begin
 if not fluid_private.research_operator_adjudication_matches('5f31a4ff-f747-4464-bc79-64b757fe5df3') then
  raise exception 'research_adjudication_readback_failed'; end if;
end $readback$;
select job_id,decision,observed_microusd,retained_microusd,recorded_at
 from fluid_private.api_text_operator_adjudications where job_id='5f31a4ff-f747-4464-bc79-64b757fe5df3';
commit;
