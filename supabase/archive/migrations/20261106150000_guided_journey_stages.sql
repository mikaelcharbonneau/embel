-- Brand journey redesign (2026-11-06), Phases 3-4: the guided interview gains
-- Positioning (Strategy 3 of 3) between Audience and Personality, and an optional
-- Slogan (Voice 3 of 3) proposed after the name is chosen:
--   competitors -> audience -> positioning -> personality -> [name] -> slogan.
-- strategy.positioning and strategy.slogan use the exact guided policy shape of
-- audience and personality. The shared worker functions are patched by the
-- reviewed post-install packet candidates/shared_guided_journey_stages.sql.
-- Exact substitutions preserve signatures, owners, attributes and ACLs.
begin;

do $guard$
declare signature text; expected text;
begin
 for signature,expected in values
  ('fluid_private.api_text_guided_policy(text,jsonb)','827ceac0ae71eebce59d5892b630755a'),
  ('fluid_private.api_text_testing_enqueue_matches(uuid,uuid,text,integer,text,jsonb,text,bigint,integer)','5f495becf16f513833b6d2eedd9ffb0a'),
  ('fluid_private.api_text_testing_job_allowed(uuid)','64b4c28de8ca14fb9045217380ebb725'),
  ('fluid_private.api_text_operation(text)','e729230c60fea83c5cfddb2177709813'),
  ('public.get_strategy_job_summaries(uuid,uuid)','e14c76e4cbc69097d547945b2fac71ac'),
  ('fluid_private.guided_interview_context(jsonb,jsonb)','08d3e6c916eb80c1bfe46eeccf03a86f') loop
  if not exists(select 1 from pg_catalog.pg_proc p where p.oid=signature::regprocedure and md5(p.prosrc)=expected
   and p.proowner=(select oid from pg_catalog.pg_roles where rolname=current_user)) then
   raise exception 'unexpected_guided_journey_predecessor: %',signature;
  end if;
 end loop;
end $guard$;

alter table fluid_private.api_text_testing_access drop constraint api_text_testing_access_operation_check;
alter table fluid_private.api_text_testing_access add constraint api_text_testing_access_operation_check
 check(operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.positioning','strategy.personality','strategy.slogan'));
alter table fluid_private.api_text_testing_admission_context drop constraint api_text_testing_admission_context_operation_check;
alter table fluid_private.api_text_testing_admission_context add constraint api_text_testing_admission_context_operation_check
 check(operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.positioning','strategy.personality','strategy.slogan'));

do $patch$
declare signature text; definition text; original text; replacement text;
begin
 for signature,original,replacement in values
  ('fluid_private.api_text_guided_policy(text,jsonb)',
   $old$p_operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality')$old$,
   $new$p_operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.positioning','strategy.personality','strategy.slogan')$new$),
  ('fluid_private.api_text_testing_enqueue_matches(uuid,uuid,text,integer,text,jsonb,text,bigint,integer)',
   $old$p_operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality')$old$,
   $new$p_operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.positioning','strategy.personality','strategy.slogan')$new$),
  ('fluid_private.api_text_testing_job_allowed(uuid)',
   $old$j.operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality')$old$,
   $new$j.operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.positioning','strategy.personality','strategy.slogan')$new$),
  ('fluid_private.api_text_operation(text)',
   $old$p_operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning')$old$,
   $new$p_operation in ('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning','strategy.slogan')$new$),
  ('public.get_strategy_job_summaries(uuid,uuid)',
   $old$j.operation in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning')$old$,
   $new$j.operation in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality','strategy.positioning','strategy.slogan')$new$),
  ('fluid_private.guided_interview_context(jsonb,jsonb)',
   $old$not in ('competitors','audience','personality','complete')$old$,
   $new$not in ('competitors','audience','positioning','personality','slogan','complete')$new$),
  ('fluid_private.guided_interview_context(jsonb,jsonb)',
   $old$coalesce(t->>'stage','') not in ('competitors','audience','personality')$old$,
   $new$coalesce(t->>'stage','') not in ('competitors','audience','positioning','personality','slogan')$new$),
  ('fluid_private.guided_interview_context(jsonb,jsonb)',
   $old$coalesce(a->>'stage','') not in ('competitors','audience','personality')$old$,
   $new$coalesce(a->>'stage','') not in ('competitors','audience','positioning','personality','slogan')$new$),
  ('fluid_private.guided_interview_context(jsonb,jsonb)',
   $old$jsonb_array_length(p_value->'answers')>3$old$,
   $new$jsonb_array_length(p_value->'answers')>5$new$) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
   raise exception 'unexpected_guided_journey_fragment: %',signature;
  end if;
  execute replace(definition,original,replacement);
 end loop;
end $patch$;
commit;
