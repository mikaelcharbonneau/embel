-- Rename (D-074, owner approval November 14, 2026) stores the project's own name as
-- context.displayName in each project revision. identity_material_context only accepts a
-- fixed list of context keys and raised invalid_identity_context for it, so Creative
-- directions could not start on a renamed project and finished directions could not be
-- checked against it.
--
-- What this changes: the function drops displayName before its key check. The name is
-- display metadata, not brand material, so the identity material (and every stored
-- identity input snapshot compared against it) stays exactly what it was without it.
-- Any other unknown key still raises invalid_identity_context. Only that one statement is
-- added; the body, signature, settings, owner and privileges are those of the baseline.
--
-- Rollback: recreate the function from 20261110190000_baseline.sql (lines 2823-2887, the
-- same body without the two lines marked below), with the same owner and revoke.

begin;

CREATE OR REPLACE FUNCTION fluid_private.identity_material_context(p_context jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
declare v jsonb:=p_context;k text;r jsonb;s jsonb;rows jsonb;src jsonb;needs jsonb;ids text[];id text;v_intake jsonb;
begin
 -- The name given with Rename (displayName) is not brand material: drop it so identity inputs stay the same.
 if jsonb_typeof(v)='object' then v:=v-'displayName';end if;
 if jsonb_typeof(v) is distinct from 'object' or v-array['description','activity','offering','knownAudience','reformulationConfirmed','audienceSegments','competitors','competitorReviewComplete','personality','positioning','selectedName','namingSource','creativeLocale','intake']<>'{}' then raise exception 'invalid_identity_context' using errcode='22023';end if;
 foreach k in array array['description','activity','offering','knownAudience','positioning','creativeLocale'] loop
  v:=jsonb_set(v,array[k],to_jsonb(fluid_private.identity_text(coalesce(v->k,case when k='creativeLocale' then '"en"'::jsonb else '""'::jsonb end),case when k='creativeLocale' then 2 else 0 end,case k when 'description' then 12000 when 'positioning' then 5000 when 'creativeLocale' then 30 else 2000 end)));
 end loop;
 if v ? 'selectedName' and v->'selectedName'<>'null' then v:=jsonb_set(v,'{selectedName}',to_jsonb(fluid_private.identity_text(v->'selectedName',0,200)));end if;
 if v ? 'intake' and jsonb_typeof(v->'intake') is distinct from 'object' then raise exception 'invalid_identity_context' using errcode='22023';end if;
 v_intake:=coalesce(v->'intake','{}');
 if v_intake-array['suppliedName','namingNotes','identityNotes','step','audienceReviewedAt','personalityReviewedAt','positioningReviewedAt','conversation','guidedInterview','example']<>'{}' then raise exception 'invalid_identity_context' using errcode='22023';end if;
 perform fluid_private.identity_text(coalesce(v_intake->'namingNotes','""'),0,2000,false);
 if v_intake ? 'step' and (jsonb_typeof(v_intake->'step') is distinct from 'string' or v_intake->>'step' not in('description','review','competitors','audience','personality','positioning')) then raise exception 'invalid_identity_context' using errcode='22023';end if;
 if v_intake ? 'example' and jsonb_typeof(v_intake->'example') is distinct from 'boolean' then raise exception 'invalid_identity_context' using errcode='22023';end if;
 foreach k in array array['audienceReviewedAt','personalityReviewedAt','positioningReviewedAt'] loop
  if v_intake ? k and v_intake->k<>'null' then perform fluid_private.identity_time_key(fluid_private.identity_text(v_intake->k,1,64,false));end if;
 end loop;
 if v_intake ? 'conversation' then perform fluid_private.identity_conversation(v_intake->'conversation');end if;
 if v_intake ? 'guidedInterview' then perform fluid_private.guided_interview_context(v_intake->'guidedInterview',v_intake->'conversation');end if;
 v:=jsonb_set(v,'{intake}',coalesce(v->'intake','{}')||jsonb_build_object('suppliedName',fluid_private.identity_text(coalesce(v#>'{intake,suppliedName}','""'),0,180,false),'identityNotes',fluid_private.identity_text(coalesce(v#>'{intake,identityNotes}','""'),0,2000,false)));
 foreach k in array array['competitors','audienceSegments'] loop
  rows:='[]';ids:='{}';
  if jsonb_typeof(coalesce(v->k,'[]'))<>'array' or jsonb_array_length(coalesce(v->k,'[]'))>(case when k='competitors' then 50 else 30 end) then raise exception 'invalid_identity_context' using errcode='22023';end if;
  for r in select value from jsonb_array_elements(coalesce(v->k,'[]')) loop
   if jsonb_typeof(r)<>'object' or jsonb_typeof(r->'id') is distinct from 'string' then raise exception 'invalid_identity_context' using errcode='22023';end if;
   id:=r->>'id';perform id::uuid;if id=any(ids) then raise exception 'invalid_identity_context' using errcode='22023';end if;ids:=array_append(ids,id);
   if jsonb_typeof(coalesce(r->'selected','false'))<>'boolean' then raise exception 'invalid_identity_context' using errcode='22023';end if;r:=r||jsonb_build_object('selected',coalesce(r->'selected','false'));
   if k='competitors' then
    if r-array['id','name','relevance','url','origin','selected','sources']<>'{}' then raise exception 'invalid_identity_context' using errcode='22023';end if;
    if r ? 'url' then perform fluid_private.identity_text(r->'url',0,2048,false);end if;
    if r->>'origin' not in('user','research') or r->>'origin' is null then raise exception 'invalid_identity_context' using errcode='22023';end if;
    r:=r||jsonb_build_object('name',fluid_private.identity_text(r->'name',1,160),'relevance',fluid_private.identity_text(r->'relevance',0,2000));
   else
    if r-array['id','label','needs','reason','selected','origin','sources']<>'{}' then raise exception 'invalid_identity_context' using errcode='22023';end if;
    if r->>'origin' not in('user','proposal') or r->>'origin' is null or jsonb_typeof(r->'needs') is distinct from 'array' or jsonb_array_length(r->'needs')>12 then raise exception 'invalid_identity_context' using errcode='22023';end if;
    select coalesce(jsonb_agg(to_jsonb(fluid_private.identity_text(value,1,2000)) order by n),'[]') into needs from jsonb_array_elements(r->'needs') with ordinality a(value,n);
    r:=r||jsonb_build_object('label',fluid_private.identity_text(r->'label',1,180),'reason',fluid_private.identity_text(r->'reason',0,2000),'needs',needs);
   end if;
   src:='[]';if jsonb_typeof(coalesce(r->'sources','[]'))<>'array' or jsonb_array_length(coalesce(r->'sources','[]'))>20 then raise exception 'invalid_identity_context' using errcode='22023';end if;
   for s in select value from jsonb_array_elements(coalesce(r->'sources','[]')) loop
    if jsonb_typeof(s)<>'object' or s-array['url','title','retrievedAt']<>'{}' or not(s ?& array['url','title','retrievedAt']) or jsonb_typeof(s->'url') is distinct from 'string' or (s->>'url')!~'^https?://' then raise exception 'invalid_identity_context' using errcode='22023';end if;
    perform fluid_private.identity_time_key(fluid_private.identity_text(s->'retrievedAt',1,64,false));
    src:=src||jsonb_build_array(s||jsonb_build_object('title',fluid_private.identity_text(s->'title',1,300)));
   end loop;
   if k='competitors' and r->>'origin'='research' and jsonb_array_length(src)=0 then raise exception 'invalid_identity_context' using errcode='22023';end if;
   rows:=rows||jsonb_build_array(r||jsonb_build_object('sources',src));
  end loop;v:=jsonb_set(v,array[k],rows);
 end loop;
 if coalesce(v->'personality','null')<>'null' then
  r:=v->'personality';if jsonb_typeof(r)<>'object' or r-array['sincerity','excitement','competence','sophistication','ruggedness']<>'{}' then raise exception 'invalid_identity_context' using errcode='22023';end if;
  foreach k in array array['sincerity','excitement','competence','sophistication','ruggedness'] loop if fluid_private.identity_counter(r->k)>100 then raise exception 'invalid_identity_context' using errcode='22023';end if;end loop;
 end if;
 v:=jsonb_build_object('description','','activity','','offering','','knownAudience','','reformulationConfirmed',false,'audienceSegments','[]'::jsonb,'competitors','[]'::jsonb,'competitorReviewComplete',false,'personality',null,'positioning','','selectedName',null,'creativeLocale','en')||v;
 v:=jsonb_set(v,'{intake}',jsonb_build_object('suppliedName','','namingNotes','','identityNotes','','step','review','audienceReviewedAt',null,'personalityReviewedAt',null,'positioningReviewedAt',null,'example',false)||(v->'intake'));
 if v ? 'namingSource' then v:=jsonb_set(v,'{namingSource}',fluid_private.identity_naming_source(v->'namingSource'));end if;
 foreach k in array array['reformulationConfirmed','competitorReviewComplete'] loop if jsonb_typeof(v->k) is distinct from 'boolean' then raise exception 'invalid_identity_context' using errcode='22023';end if;end loop;
 if v->'reformulationConfirmed'='true' and (v->>'activity'='' or v->>'offering'='') then raise exception 'invalid_identity_context' using errcode='22023';end if;
 if v->'competitorReviewComplete'='true' and exists(select 1 from jsonb_array_elements(v->'competitors') x where x->'selected'='true' and x->>'relevance'='') then raise exception 'invalid_identity_context' using errcode='22023';end if;
 if v#>'{intake,personalityReviewedAt}'<>'null' and v->'personality'='null' then raise exception 'invalid_identity_context' using errcode='22023';end if;
 if v#>'{intake,positioningReviewedAt}'<>'null' and(v->>'positioning'='' or v#>'{intake,personalityReviewedAt}'='null') then raise exception 'invalid_identity_context' using errcode='22023';end if;
 return v;
end $$;

ALTER FUNCTION fluid_private.identity_material_context(p_context jsonb) OWNER TO postgres;

REVOKE ALL ON FUNCTION fluid_private.identity_material_context(p_context jsonb) FROM PUBLIC;

commit;
