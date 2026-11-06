-- Brand journey redesign (2026-11-06): the shared Strategy worker admits the
-- guided Positioning and Slogan questions. Additive post-install correction:
-- exact substitutions only; signatures, owners, attributes and ACLs are kept.
-- Pairs with migrations/20261106150000_guided_journey_stages.sql.
begin;
do $shared_guided_journey$
declare signature text; definition text; original text; replacement text;
begin
 for signature,original,replacement in values
  ('public.enqueue_shared_strategy_job(uuid,integer,text,text,text)',
   $old$p_operation not in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality')$old$,
   $new$p_operation not in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.positioning','strategy.personality','strategy.slogan')$new$),
  ('public.get_shared_strategy_availability(uuid)',
   $old$p.operation in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality')$old$,
   $new$p.operation in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.positioning','strategy.personality','strategy.slogan')$new$),
  ('fluid_private.shared_strategy_job(uuid)',
   $old$j.operation in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.personality')$old$,
   $new$j.operation in('strategy.reformulate','strategy.competitors','strategy.audience','strategy.positioning','strategy.personality','strategy.slogan')$new$) loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
   raise exception 'unexpected_shared_guided_journey_fragment: %',signature;
  end if;
  execute replace(definition,original,replacement);
 end loop;
end $shared_guided_journey$;
commit;
