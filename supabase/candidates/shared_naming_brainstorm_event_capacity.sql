-- Additive event capacity repair. Original Naming31d packet stays immutable.
-- No retained row, role/grant or policy is rewritten. The gateway changes only
-- one ambiguous column qualifier; the frozen Naming31d source stays unchanged.
BEGIN;
SET LOCAL search_path='';SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='30s';
DO $event_capacity$
DECLARE phase text:='apply';t oid;old_key oid;idx pg_catalog.pg_index;installed boolean;f pg_catalog.pg_proc;
 before_rows text;after_rows text;before_functions jsonb;after_functions jsonb;before_security jsonb;after_security jsonb;
 before_constraints jsonb;after_constraints jsonb;before_triggers jsonb;after_triggers jsonb;g record;
 before_gateway jsonb;after_gateway jsonb;gateway_body text;gateway_definition text;
BEGIN
 IF phase NOT IN('prepare','apply','resume')OR current_user<>'postgres'OR session_user<>'postgres'OR current_database()<>'postgres'
  OR current_setting('server_version_num')::integer<>170011 OR current_setting('server_encoding')<>'UTF8'OR current_setting('block_size')::integer<>8192
  OR NOT EXISTS(SELECT 1 FROM fluid_private.shared_http_target q WHERE q.singleton AND q.mode='hosted'AND q.origin='https://fricsfwqibyhemknqgyf.supabase.co')
  THEN RAISE EXCEPTION 'brainstorm_event_capacity_operator_target';END IF;
 t:=to_regclass('fluid_private.naming_brainstorm_events');
 IF t IS NULL THEN RAISE EXCEPTION 'brainstorm_event_capacity_table_missing';END IF;
 -- Pin all predecessor checks and snapshots under the same bounded DDL lock.
 LOCK TABLE fluid_private.naming_brainstorm_events IN ACCESS EXCLUSIVE MODE;
 IF t IS NULL OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=t AND relkind='r'AND relowner=to_regrole('postgres')AND relrowsecurity AND relforcerowsecurity)
  OR EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a WHERE c.oid=t AND a.grantee<>c.relowner)
  OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=t)
  OR(SELECT jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod),attnotnull)ORDER BY attnum)FROM pg_attribute WHERE attrelid=t AND attnum>0 AND NOT attisdropped)
   IS DISTINCT FROM '[["event_id","uuid",true],["call_id","uuid",true],["kind","text",true],["payload","jsonb",true],["created_at","timestamp with time zone",true]]'::jsonb
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t AND tgname='brainstorm_history_immutable'AND tgtype=27 AND tgenabled='O'AND NOT tgisinternal AND tgfoid='fluid_private.prevent_history_change()'::regprocedure)
  THEN RAISE EXCEPTION 'brainstorm_event_capacity_table_predecessor';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure
  AND encode(sha256(convert_to(prosrc,'UTF8')),'hex') IN('e8bae9ed6a46f0b87e8c78474d5d059dd608b27442421e730d2f0c9f4e599ea4','5b9e16f786364d7cb5e58a5b9380a1da3490f5c950f8dfb7f47fde435518d7f9')
  AND proowner=to_regrole('postgres')AND prosecdef AND provolatile='v'AND NOT proleakproof AND proconfig=ARRAY['search_path=""'])
  THEN RAISE EXCEPTION 'brainstorm_event_capacity_gateway_predecessor';END IF;
 SELECT oid INTO old_key FROM pg_constraint WHERE conrelid=t AND conname='naming_brainstorm_events_call_id_payload_key';
 installed:=old_key IS NULL;
 SELECT prosrc,to_jsonb(p)-'prosrc'INTO gateway_body,before_gateway FROM pg_proc p WHERE oid='public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure;
 IF encode(sha256(convert_to(gateway_body,'UTF8')),'hex') IS DISTINCT FROM (CASE WHEN installed THEN '5b9e16f786364d7cb5e58a5b9380a1da3490f5c950f8dfb7f47fde435518d7f9' ELSE 'e8bae9ed6a46f0b87e8c78474d5d059dd608b27442421e730d2f0c9f4e599ea4' END)
  THEN RAISE EXCEPTION 'brainstorm_event_capacity_gateway_phase';END IF;
 IF NOT installed THEN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE oid=old_key AND contype='u'AND conkey=ARRAY[2,4]::smallint[]AND NOT condeferrable AND NOT condeferred AND convalidated)
   THEN RAISE EXCEPTION 'brainstorm_event_capacity_unique_predecessor';END IF;
  SELECT i.*INTO idx FROM pg_index i JOIN pg_constraint c ON c.conindid=i.indexrelid WHERE c.oid=old_key;
  IF NOT idx.indisunique OR NOT idx.indisvalid OR NOT idx.indisready OR NOT idx.indislive OR idx.indisprimary OR idx.indnullsnotdistinct
   OR idx.indnkeyatts<>2 OR idx.indnatts<>2 OR idx.indkey::text<>'2 4'OR idx.indcollation::text<>'0 0'OR idx.indoption::text<>'0 0'
   OR idx.indexprs IS NOT NULL OR idx.indpred IS NOT NULL
   OR(SELECT am.amname FROM pg_class c JOIN pg_am am ON am.oid=c.relam WHERE c.oid=idx.indexrelid)<>'btree'
   OR(SELECT array_agg(o.opcname ORDER BY k.n)FROM unnest(idx.indclass)WITH ORDINALITY k(oid,n)JOIN pg_opclass o ON o.oid=k.oid)<>ARRAY['uuid_ops','jsonb_ops']::name[]
   THEN RAISE EXCEPTION 'brainstorm_event_capacity_index_predecessor';END IF;
  IF to_regclass('fluid_private.naming_brainstorm_events_payload_bucket_v1')IS NOT NULL
   OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fluid_private'AND p.proname='naming_brainstorm_event_replay_guard_v1')
   OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t AND tgname='brainstorm_event_replay_guard_v1')
   OR(SELECT count(*)FROM pg_constraint WHERE conrelid=t)<>5 OR(SELECT count(*)FROM pg_index WHERE indrelid=t)<>2
   OR(SELECT count(*)FROM pg_trigger WHERE tgrelid=t AND NOT tgisinternal)<>1
   THEN RAISE EXCEPTION 'brainstorm_event_capacity_partial_collision';END IF;
  IF phase='resume'THEN RAISE EXCEPTION 'brainstorm_event_capacity_not_installed';END IF;
 END IF;
 SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(e)ORDER BY event_id),'[]')::text,'UTF8')),'hex')INTO before_rows FROM fluid_private.naming_brainstorm_events e;
 SELECT coalesce(jsonb_agg(to_jsonb(p)ORDER BY p.oid),'[]')INTO before_functions FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN('public','fluid_private')AND p.proname<>'naming_brainstorm_event_replay_guard_v1'AND p.oid<>'public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure;
 SELECT jsonb_build_object('roles',(SELECT jsonb_agg(to_jsonb(r)ORDER BY oid)FROM pg_roles r),'memberships',(SELECT coalesce(jsonb_agg(to_jsonb(m)ORDER BY to_jsonb(m)::text),'[]')FROM pg_auth_members m),
  'table',(SELECT to_jsonb(c)-ARRAY['relpages','reltuples','relallvisible']FROM pg_class c WHERE c.oid=t),'columns',(SELECT jsonb_agg(to_jsonb(a)ORDER BY attnum)FROM pg_attribute a WHERE attrelid=t),
  'policies',(SELECT coalesce(jsonb_agg(to_jsonb(p)ORDER BY oid),'[]')FROM pg_policy p),'defaults',(SELECT coalesce(jsonb_agg(to_jsonb(d)ORDER BY oid),'[]')FROM pg_default_acl d))INTO before_security;
 SELECT jsonb_agg(to_jsonb(c)ORDER BY oid)INTO before_constraints FROM pg_constraint c WHERE conrelid=t AND c.oid IS DISTINCT FROM old_key;
 SELECT jsonb_agg(to_jsonb(tr)ORDER BY oid)INTO before_triggers FROM pg_trigger tr WHERE tgrelid=t AND tgname<>'brainstorm_event_replay_guard_v1';
 IF phase='apply'AND NOT installed THEN
  ALTER TABLE fluid_private.naming_brainstorm_events DROP CONSTRAINT naming_brainstorm_events_call_id_payload_key;
  CREATE INDEX naming_brainstorm_events_payload_bucket_v1 ON fluid_private.naming_brainstorm_events(call_id,pg_catalog.jsonb_hash_extended(payload,0));
  EXECUTE $create_guard$CREATE FUNCTION fluid_private.naming_brainstorm_event_replay_guard_v1()RETURNS trigger
   LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $guard_body$
begin
 if tg_op<>'INSERT' or tg_table_schema<>'fluid_private' or tg_table_name<>'naming_brainstorm_events' or tg_nargs<>0 then
  raise exception 'brainstorm_event_replay_trigger_scope' using errcode='55000';
 end if;
 -- A new snapshot after the parent lock is required for exact concurrent replay.
 -- Other isolation levels fail closed rather than accepting a stale equality read.
 if current_setting('transaction_isolation')<>'read committed' then
  raise exception 'brainstorm_event_replay_requires_read_committed' using errcode='25001';
 end if;
 perform 1 from fluid_private.naming_brainstorm_calls c where c.call_id=new.call_id for update;
 if not found then raise exception 'brainstorm_event_call_missing' using errcode='23503';end if;
 -- The bucket is nonunique and uses PostgreSQL's JSONB equality-compatible hash.
 -- Collisions only add equality comparisons; they can never suppress a distinct row.
 if exists(select 1 from fluid_private.naming_brainstorm_events e where e.call_id=new.call_id
  and pg_catalog.jsonb_hash_extended(e.payload,0)=pg_catalog.jsonb_hash_extended(new.payload,0)
  and e.payload=new.payload) then return null;end if;
 return new;
end $guard_body$;$create_guard$;
  FOR g IN SELECT DISTINCT a.grantee FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
   WHERE p.oid='fluid_private.naming_brainstorm_event_replay_guard_v1()'::regprocedure AND a.grantee<>p.proowner LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION fluid_private.naming_brainstorm_event_replay_guard_v1() FROM %s CASCADE',CASE WHEN g.grantee=0 THEN 'PUBLIC'ELSE quote_ident(pg_get_userbyid(g.grantee))END);
  END LOOP;
  CREATE TRIGGER brainstorm_event_replay_guard_v1 BEFORE INSERT ON fluid_private.naming_brainstorm_events FOR EACH ROW EXECUTE FUNCTION fluid_private.naming_brainstorm_event_replay_guard_v1();
  -- Exact source-derived qualifier correction. No action or permission changes.
  gateway_definition:=pg_get_functiondef('public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure);
  IF length(gateway_definition)-length(replace(gateway_definition,'select 1 from fluid_private.naming_brainstorm_events where call_id=c.call_id and payload=p_args',''))<>length('select 1 from fluid_private.naming_brainstorm_events where call_id=c.call_id and payload=p_args')
   THEN RAISE EXCEPTION 'brainstorm_event_capacity_gateway_replacement_count';END IF;
  EXECUTE replace(gateway_definition,'select 1 from fluid_private.naming_brainstorm_events where call_id=c.call_id and payload=p_args','select 1 from fluid_private.naming_brainstorm_events replay_event where replay_event.call_id=c.call_id and replay_event.payload=p_args');
  installed:=true;
 END IF;
 IF installed THEN
  SELECT *INTO f FROM pg_proc WHERE oid=to_regprocedure('fluid_private.naming_brainstorm_event_replay_guard_v1()');
  IF f.oid IS NULL OR encode(sha256(convert_to(f.prosrc,'UTF8')),'hex')<>'e63cc7846deb8f7480fdf713943121ff7fcc9f0da7ca231e2ac8dfc945687d4c' OR f.proowner<>to_regrole('postgres')OR f.prosecdef OR f.provolatile<>'v'OR f.proleakproof OR f.proconfig IS DISTINCT FROM ARRAY['search_path=""']
   OR f.prorettype<>'trigger'::regtype OR f.pronargs<>0 OR(SELECT lanname FROM pg_language WHERE oid=f.prolang)<>'plpgsql'
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner)))a WHERE a.grantee<>f.proowner)
   OR(SELECT count(*)FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='fluid_private'AND p.proname='naming_brainstorm_event_replay_guard_v1')<>1
   THEN RAISE EXCEPTION 'brainstorm_event_capacity_guard_changed';END IF;
  SELECT *INTO idx FROM pg_index WHERE indexrelid=to_regclass('fluid_private.naming_brainstorm_events_payload_bucket_v1');
  IF idx.indexrelid IS NULL OR idx.indrelid<>t OR idx.indisunique OR NOT idx.indisvalid OR NOT idx.indisready OR NOT idx.indislive OR idx.indisprimary
   OR idx.indnkeyatts<>2 OR idx.indnatts<>2 OR idx.indkey::text<>'2 0'OR idx.indpred IS NOT NULL
   OR pg_get_expr(idx.indexprs,idx.indrelid)IS DISTINCT FROM 'jsonb_hash_extended(payload, (0)::bigint)'
   OR(SELECT am.amname FROM pg_class c JOIN pg_am am ON am.oid=c.relam WHERE c.oid=idx.indexrelid)<>'btree'
   OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=t AND conname='naming_brainstorm_events_call_id_payload_key')
   OR(SELECT count(*)FROM pg_constraint WHERE conrelid=t)<>4 OR(SELECT count(*)FROM pg_index WHERE indrelid=t)<>2
   OR(SELECT count(*)FROM pg_trigger WHERE tgrelid=t AND NOT tgisinternal)<>2
   OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t AND tgname='brainstorm_event_replay_guard_v1'AND tgtype=7 AND tgenabled='O'AND NOT tgisinternal AND tgnargs=0 AND tgqual IS NULL AND tgfoid=f.oid)
   THEN RAISE EXCEPTION 'brainstorm_event_capacity_installed_shape_changed';END IF;
 END IF;
 SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(e)ORDER BY event_id),'[]')::text,'UTF8')),'hex')INTO after_rows FROM fluid_private.naming_brainstorm_events e;
 SELECT coalesce(jsonb_agg(to_jsonb(p)ORDER BY p.oid),'[]')INTO after_functions FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN('public','fluid_private')AND p.proname<>'naming_brainstorm_event_replay_guard_v1'AND p.oid<>'public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure;
 SELECT jsonb_build_object('roles',(SELECT jsonb_agg(to_jsonb(r)ORDER BY oid)FROM pg_roles r),'memberships',(SELECT coalesce(jsonb_agg(to_jsonb(m)ORDER BY to_jsonb(m)::text),'[]')FROM pg_auth_members m),
  'table',(SELECT to_jsonb(c)-ARRAY['relpages','reltuples','relallvisible']FROM pg_class c WHERE c.oid=t),'columns',(SELECT jsonb_agg(to_jsonb(a)ORDER BY attnum)FROM pg_attribute a WHERE attrelid=t),
  'policies',(SELECT coalesce(jsonb_agg(to_jsonb(p)ORDER BY oid),'[]')FROM pg_policy p),'defaults',(SELECT coalesce(jsonb_agg(to_jsonb(d)ORDER BY oid),'[]')FROM pg_default_acl d))INTO after_security;
 SELECT jsonb_agg(to_jsonb(c)ORDER BY oid)INTO after_constraints FROM pg_constraint c WHERE conrelid=t AND c.oid IS DISTINCT FROM old_key;
 SELECT jsonb_agg(to_jsonb(tr)ORDER BY oid)INTO after_triggers FROM pg_trigger tr WHERE tgrelid=t AND tgname<>'brainstorm_event_replay_guard_v1';
 SELECT to_jsonb(p)-'prosrc'INTO after_gateway FROM pg_proc p WHERE oid='public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure;
 IF before_gateway IS DISTINCT FROM after_gateway OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.shared_naming_worker_action(jsonb,jsonb,text,jsonb)'::regprocedure
  AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')=CASE WHEN installed THEN '5b9e16f786364d7cb5e58a5b9380a1da3490f5c950f8dfb7f47fde435518d7f9' ELSE 'e8bae9ed6a46f0b87e8c78474d5d059dd608b27442421e730d2f0c9f4e599ea4' END)
  THEN RAISE EXCEPTION 'brainstorm_event_capacity_gateway_changed';END IF;
 IF before_rows IS DISTINCT FROM after_rows OR before_functions IS DISTINCT FROM after_functions OR before_security IS DISTINCT FROM after_security
  OR before_constraints IS DISTINCT FROM after_constraints OR before_triggers IS DISTINCT FROM after_triggers
  THEN RAISE EXCEPTION 'brainstorm_event_capacity_unrelated_change';END IF;
END $event_capacity$;
COMMIT;
