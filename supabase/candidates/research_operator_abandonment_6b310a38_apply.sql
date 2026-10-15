-- REVIEW-ONLY, NOT APPLIED. Requires a separate operator policy decision.
-- The operator acknowledges that this response is unusable and that provider
-- billing remains unresolved. The source proof is branch order in the reviewed
-- af6faf1 adapter, not recovered provider data. No source/citation is verified.
-- Install the paired candidate only after review. This statement changes only
-- the one job's state/error/finished_at and appends its immutable receipt.
-- All original evidence and the entire remaining 15,818,215-microdollar hold stay.
-- Replace the deliberately invalid decision-reference placeholder only after
-- an actual external operator decision exists. SQL records that attestation;
-- it cannot independently verify the external authorization.
begin;
insert into fluid_private.api_text_operator_adjudications(
 job_id,owner_id,project_id,step_id,output_sha256,source_revision,source_adapter_sha256,
 terminal_evidence,decision,operator_decision_reference,reason,reserved_microusd,observed_microusd,retained_microusd)
values(
 '6b310a38-eadf-4d64-9474-b7632cfa2340','6840f4c2-15a6-45a7-97be-41e7e5e37f42',
 '8aa59964-7057-4a96-8142-82561fc5ffda','bf70b5ce-3a48-4b8d-92c0-f4e29b145595',
 'c787e1485edc74f13cd1d03736b536933b7a3c75fc9f5ac826e7890977382dde',
 'af6faf18912cc24afb37179a6988a11f83cf9cdf','419acb2adcdb5bf27ee99f92bf3f737876efad9ca8c4a7c1836f1c00a68a1255',
 'reviewed_source_branch_order_provider_unexpected_output_after_completed',
 'abandon_unusable_result_billing_unresolved',
 'REPLACE_APPROVED_OPERATOR_DECISION_REFERENCE',
 'Operator abandons this unusable completed research response. Complete provider billing, tool compliance, and source verification remain unresolved. Original ambiguous evidence and the full remaining reservation are retained; no refund, final-cost assertion, publication, or automatic retry is authorized by this receipt.',
 15892880,74665,15818215);
do $readback$
begin
 if not fluid_private.research_operator_adjudication_matches('6b310a38-eadf-4d64-9474-b7632cfa2340') then
  raise exception 'research_adjudication_readback_failed'; end if;
end $readback$;
select job_id,decision,observed_microusd,retained_microusd,recorded_at
 from fluid_private.api_text_operator_adjudications where job_id='6b310a38-eadf-4d64-9474-b7632cfa2340';
commit;
