-- REVIEW-ONLY, NOT APPLIED. Requires an external operator decision after QA.
-- This marks only the pinned unusable request failed and appends its receipt.
-- The ambiguous output, provider IDs and all accounting remain unchanged.
-- The whole 15,822,842-microdollar outstanding hold remains active; observed
-- 70,038 microdollars remain recorded. No settlement, refund or retry occurs.
-- source_revision identifies an inspected local source snapshot, NOT a verified
-- deployed Git revision. The retained diagnostics are the terminal evidence.
begin;
insert into fluid_private.api_text_operator_adjudications(
 job_id,owner_id,project_id,step_id,output_sha256,source_revision,source_adapter_sha256,
 terminal_evidence,decision,operator_decision_reference,reason,reserved_microusd,observed_microusd,retained_microusd)
values(
 'beb22588-79a8-4f59-a403-5d540e811315','6840f4c2-15a6-45a7-97be-41e7e5e37f42',
 'fecf071f-8b3c-48da-bdd5-39ea75e0a537','904cfc01-ff0e-4a04-a4c7-5f4c85cc32bf',
 '67d92b51de3c01b002123d57ca43003c063ae8acb96f406e91b0c3e5874a1bed',
 'source-snapshot-sha256:61ae3050a5bf5cc75986a4a5c39dae1834cd35b0128c87fe41b1b5f824a3e5c5',
 '61ae3050a5bf5cc75986a4a5c39dae1834cd35b0128c87fe41b1b5f824a3e5c5',
 'retained_completed_diagnostics_bounded_semantic_rejection',
 'abandon_unusable_result_billing_unresolved',
 'REPLACE_APPROVED_OPERATOR_DECISION_REFERENCE',
 'Operator abandons this unusable research response. Retained diagnostics identify a completed envelope, two completed searches and bounded observed usage; one proposed website lacks observed-source evidence, so the output was rejected. The original response cannot be promoted to success or final billing. The original ambiguous step and all financial records are retained unchanged. This receipt neither settles nor releases the remaining hold and does not publish or automatically retry research.',
 15892880,70038,15822842);
do $readback$
begin
 if not fluid_private.research_operator_adjudication_matches('beb22588-79a8-4f59-a403-5d540e811315') then
  raise exception 'research_adjudication_readback_failed'; end if;
 if not fluid_private.research_operator_adjudication_matches('6b310a38-eadf-4d64-9474-b7632cfa2340')
  or not fluid_private.research_operator_adjudication_matches('5f31a4ff-f747-4464-bc79-64b757fe5df3') then
  raise exception 'previous_research_adjudication_mismatch'; end if;
 if (select encode(sha256(convert_to(to_jsonb(l)::text,'UTF8')),'hex') from public.usage_accounts l
  where owner_id='6840f4c2-15a6-45a7-97be-41e7e5e37f42') is distinct from
   'b8a103280f61e6bb333b998b475627aefa934bb85a1562a23e05a1e2fed3aedf' then
  raise exception 'research_adjudication_accounting_changed'; end if;
end $readback$;
select job_id,decision,observed_microusd,retained_microusd,recorded_at
 from fluid_private.api_text_operator_adjudications where job_id='beb22588-79a8-4f59-a403-5d540e811315';
commit;
