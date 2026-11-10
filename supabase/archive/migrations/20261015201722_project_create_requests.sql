-- Replay-safe ordinary project creation. The existing create_project function,
-- its OID/signature and its callers/privileges remain unchanged.
begin;

create table fluid_private.project_create_requests (
  owner_id uuid not null references auth.users(id),
  request_key uuid not null,
  project_id uuid not null,
  payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(owner_id,request_key),
  unique(project_id),
  foreign key(project_id,owner_id) references public.projects(id,owner_id)
);
alter table fluid_private.project_create_requests enable row level security;
alter table fluid_private.project_create_requests force row level security;
revoke all on table fluid_private.project_create_requests from public,anon,authenticated,service_role;
create trigger project_create_requests_immutable before update or delete
  on fluid_private.project_create_requests for each row
  execute function fluid_private.prevent_history_change();

create function fluid_private.create_project_with_request(
  p_request_key uuid,p_scope text,p_title text,p_context jsonb,p_input_hash text
) returns table(
  id uuid,owner_id uuid,scope text,title text,current_revision integer,created_at timestamptz,context jsonb
) language plpgsql security definer set search_path='' as $$
declare
  v_owner uuid := auth.uid();
  v_payload_hash text;
  v_receipt fluid_private.project_create_requests;
  v_project public.projects;
begin
  if v_owner is null then raise exception 'not_found' using errcode='P0002'; end if;
  if p_request_key is null then raise exception 'invalid_request_key' using errcode='22023'; end if;

  -- Compute the receipt digest from the captured payload, independently of the
  -- caller-provided context hash. jsonb gives equivalent key order one identity.
  v_payload_hash := encode(sha256(convert_to(jsonb_build_object(
    'scope',p_scope,'title',p_title,'context',p_context,'input_hash',p_input_hash
  )::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(v_owner::text||':project:create:'||p_request_key::text,0));
  select r.* into v_receipt from fluid_private.project_create_requests r
    where r.owner_id=v_owner and r.request_key=p_request_key;
  if found then
    if v_receipt.payload_hash is distinct from v_payload_hash then
      raise exception 'request_conflict' using errcode='PT409';
    end if;
  else
    -- The creation and receipt commit or roll back together. Failed validation
    -- leaves neither a project nor a consumed request key.
    v_project := public.create_project(p_scope,p_title,p_context,p_input_hash);
    insert into fluid_private.project_create_requests(owner_id,request_key,project_id,payload_hash)
      values(v_owner,p_request_key,v_project.id,v_payload_hash) returning * into v_receipt;
  end if;

  -- One join observes the current revision and context together. Recovery must
  -- never relabel the first context as a newer revision or overwrite later work.
  return query select p.id,p.owner_id,p.scope,p.title,p.current_revision,p.created_at,r.context
    from public.projects p join public.project_revisions r
      on (r.project_id,r.owner_id,r.revision)=(p.id,p.owner_id,p.current_revision)
    where p.id=v_receipt.project_id and p.owner_id=v_owner;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
end $$;

-- A parsed SQL wrapper resolves the private helper without granting callers
-- USAGE on its schema. The new privileged implementation is not API-exposed.
create function public.create_project_with_request(
  p_request_key uuid,p_scope text,p_title text,p_context jsonb,p_input_hash text
) returns table(
  id uuid,owner_id uuid,scope text,title text,current_revision integer,created_at timestamptz,context jsonb
) language sql security invoker set search_path=''
begin atomic
  select * from fluid_private.create_project_with_request(p_request_key,p_scope,p_title,p_context,p_input_hash);
end;

-- Default privileges can include additional worker roles. Remove every grant
-- except the owner on only these new objects before granting the intended API.
do $$ declare obj record; access record; target text; begin
  for obj in select c.oid,c.relowner from pg_class c
    where c.oid='fluid_private.project_create_requests'::regclass loop
    target:=obj.oid::regclass::text;
    for access in select distinct a.grantee,r.rolname from pg_class c
      cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      left join pg_roles r on r.oid=a.grantee where c.oid=obj.oid and a.grantee<>obj.relowner loop
      execute 'revoke all on table '||target||' from '||case when access.grantee=0 then 'PUBLIC' else quote_ident(access.rolname) end;
    end loop;
  end loop;
  for obj in select p.oid,p.proowner from pg_proc p where p.oid in(
    'fluid_private.create_project_with_request(uuid,text,text,jsonb,text)'::regprocedure,
    'public.create_project_with_request(uuid,text,text,jsonb,text)'::regprocedure
  ) loop
    target:=obj.oid::regprocedure::text;
    for access in select distinct a.grantee,r.rolname from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      left join pg_roles r on r.oid=a.grantee where p.oid=obj.oid and a.grantee<>obj.proowner loop
      execute 'revoke all on function '||target||' from '||case when access.grantee=0 then 'PUBLIC' else quote_ident(access.rolname) end;
    end loop;
  end loop;
end $$;
grant execute on function public.create_project_with_request(uuid,text,text,jsonb,text),
  fluid_private.create_project_with_request(uuid,text,text,jsonb,text) to authenticated;

commit;
