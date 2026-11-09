-- UNAPPLIED. Shared image model gpt-image-2.6-sunburst (November 9, 2026).
-- Requires shared_logo_style_notes.sql and every earlier shared packet.
--
-- Shared Logo concepts and refinements and Creative direction boards move from
-- gpt-image-2.5-sunburst-2026-09-08 to gpt-image-2.6-sunburst. OpenAI publishes
-- 2.6 as an alias only, at the same per-token rates. The worker now asks for
-- Logo images at the highest quality on a transparent background; that is
-- request behavior, not database policy.
--
-- New admissions require 2.6: the shared raster policy, the Creative direction
-- policy and the requested model Creative direction reports. Usage evidence
-- stays truthful across the change: a stored raster response remains valid
-- under either model, and a newly recorded raster response or board receipt
-- must name the model of the policy its own job was admitted under, so work
-- admitted under 2.5 before the release can still record what it was charged.
-- The earlier capped Logo policy (maxCostMicrousd) keeps the 2.5 snapshot.
-- Each edit is checked against its reviewed predecessor body.
--
-- Slot policies still naming 2.5 stop qualifying until the worker registers its
-- new policies. Rows, receipts and recorded usage are unchanged.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
do $guard$
begin
 if current_user<>'postgres' or session_user<>current_user
  or to_regclass('public.logo_style_notes') is null
  or to_regprocedure('fluid_private.shared_logo_style_note_observation_valid(jsonb,jsonb)') is null
 then raise exception 'shared_image_model_prerequisite' using errcode='55000'; end if;
end $guard$;

create function pg_temp.image_model_edit(p_target regprocedure,p_hash text,p_needles text[],p_replacements text[],p_counts integer[]) returns void
language plpgsql set search_path='' as $$declare body text; original text; definition text; i integer; n integer; begin
 select prosrc into body from pg_catalog.pg_proc where oid=p_target; original:=body;
 if encode(sha256(convert_to(body,'UTF8')),'hex') is distinct from p_hash then raise exception 'shared_image_model_predecessor_mismatch: %',p_target; end if;
 definition:=pg_get_functiondef(p_target);
 for i in 1..array_length(p_needles,1) loop
  n:=(length(body)-length(replace(body,p_needles[i],'')))/length(p_needles[i]);
  if n<>p_counts[i] then raise exception 'shared_image_model_fragment_mismatch: % (%: % found)',p_target,i,n; end if;
  body:=replace(body,p_needles[i],p_replacements[i]);
 end loop;
 execute replace(definition,original,body);
end $$;

do $edits$
declare old_model constant text:=$m$'gpt-image-2.5-sunburst-2026-09-08'$m$; new_model constant text:=$m$'gpt-image-2.6-sunburst'$m$;
 admitted constant text:=$f$(select a.policy->>'model' from fluid_private.shared_job_admissions a where a.job_id=j.id)$f$;
begin
 -- New admissions.
 perform pg_temp.image_model_edit('fluid_private.shared_logo_raster_policy_valid(text,jsonb)','6e07e1c0a55437933d3dad1b519cf9d96f6cbf22f2ee5a84d85aea9fa88b6078',
  array[old_model],array[new_model],array[1]);
 perform pg_temp.image_model_edit('fluid_private.shared_identity_policy_valid(jsonb)','e2351a1d36fe75bdb592fa28f36de3b9cd0e498a6ce1491e7dbba15cda17d9c7',
  array[old_model],array[new_model],array[1]);
 -- Both the unavailable and the available answer name the requested model.
 perform pg_temp.image_model_edit('public.get_shared_identity_availability(uuid)','f14686c3fcf29159065f15c44e817bb7e73e7dc14502baf59e59448cb8ad8dc3',
  array[old_model],array[new_model],array[2]);
 -- Usage evidence: stored responses stay valid; a new one names its job's admitted model.
 perform pg_temp.image_model_edit('fluid_private.shared_logo_raster_observation_valid(jsonb)','b0cb8a192a0efce31f637c7fa2c11553f06217a6a60d97a76991a250b2daabd3',
  array[$f$o->>'model' is distinct from 'gpt-image-2.5-sunburst-2026-09-08'$f$],
  array[$f$(o->>'model' in('gpt-image-2.6-sunburst','gpt-image-2.5-sunburst-2026-09-08')) is not true$f$],array[1]);
 perform pg_temp.image_model_edit('fluid_private.shared_logo_record_response(uuid,uuid,jsonb)','a0622f75d8df889907a2f321e42fa902bdc786da4223c65db0e54d185d299b18',
  array['fluid_private.shared_logo_raster_observation_valid(o)'],
  array['(fluid_private.shared_logo_raster_observation_valid(o) and o->>''model'' is not distinct from '||admitted||')'],array[2]);
 perform pg_temp.image_model_edit('fluid_private.shared_identity_receipt_complete(public.jobs,fluid_private.shared_identity_receipts,text)','8f41b1dc3e67af22b40cab680a85ecde6ad7e5f5d168b515c12edf663937cd37',
  array[$f$o->>'model'<>'gpt-image-2.5-sunburst-2026-09-08'$f$],array['o->>''model'' is distinct from '||admitted],array[1]);
end $edits$;
drop function pg_temp.image_model_edit(regprocedure,text,text[],text[],integer[]);
commit;
