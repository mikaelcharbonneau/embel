-- Curated reference designs are not owned/generated assets. Only the project's
-- preferences are private. Existing uploaded reference/media contracts stay intact.
begin;
create table fluid_private.inspiration_catalog (
 id uuid primary key,
 catalog_version text not null check(catalog_version='2026-10-13.1'),
 descriptor jsonb not null check(jsonb_typeof(descriptor)='object'),
 relevant_elements text[] not null check(relevant_elements=fluid_private.reference_elements(to_jsonb(relevant_elements)))
);
revoke all on fluid_private.inspiration_catalog from public,anon,authenticated,service_role;
create trigger inspiration_catalog_immutable before update or delete on fluid_private.inspiration_catalog
 for each row execute function fluid_private.prevent_history_change();

create table public.project_inspiration_heads (
 project_id uuid not null, owner_id uuid not null,
 revision bigint not null default 0 check(revision between 0 and 9007199254740991),
 primary key(project_id,owner_id),
 foreign key(project_id,owner_id) references public.projects(id,owner_id)
);
create table public.project_inspiration_choices (
 project_id uuid not null, owner_id uuid not null, reference_id uuid not null references fluid_private.inspiration_catalog(id),
 revision bigint not null check(revision between 1 and 9007199254740991),
 ensemble boolean not null, elements text[] not null check(elements=fluid_private.reference_elements(to_jsonb(elements))),
 updated_at timestamptz not null default clock_timestamp() check(isfinite(updated_at)),
 primary key(project_id,owner_id,reference_id),
 foreign key(project_id,owner_id) references public.projects(id,owner_id)
);
do $$ declare t text; begin
 foreach t in array array['project_inspiration_heads','project_inspiration_choices'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy owned_read on public.%I for select to authenticated using(owner_id=(select auth.uid()))',t);
 end loop;
end $$;

create function public.get_project_inspiration(p_project_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_project public.projects;
begin
 select * into v_project from public.projects where id=p_project_id and owner_id=v_owner;
 if not found then raise exception 'project_not_found' using errcode='P0002'; end if;
 return jsonb_build_object('ownerId',v_owner,'projectId',p_project_id,
  'projectTitle',v_project.title,'projectScope',v_project.scope,'projectRevision',v_project.current_revision,
  'catalogVersion','2026-10-13.1','selectionRevision',coalesce((select revision from public.project_inspiration_heads where project_id=p_project_id and owner_id=v_owner),0),
  'choices',coalesce((select jsonb_agg(jsonb_build_object('referenceId',c.reference_id,'ownerId',c.owner_id,'projectId',c.project_id,
   'revision',c.revision,'ensemble',c.ensemble,'elements',c.elements,'updatedAt',c.updated_at) order by c.reference_id)
   from public.project_inspiration_choices c where c.project_id=p_project_id and c.owner_id=v_owner),'[]'::jsonb));
end $$;

create function public.set_project_inspiration_reaction(p_project_id uuid,p_reference_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid(); v_project public.projects; v_catalog fluid_private.inspiration_catalog;
 v_expected numeric; v_project_revision numeric; v_elements text[]; v_previous bigint;
begin
 -- Same lock used by project/context writers: scope and revision cannot change
 -- between admission and the preference write. auth.uid(), never a body owner.
 select * into v_project from public.projects where id=p_project_id and owner_id=v_owner for update;
 if not found then raise exception 'project_not_found' using errcode='P0002'; end if;
 if v_project.scope='naming_only' then raise exception 'inspiration_scope' using errcode='22023'; end if;
 if jsonb_typeof(p_input) is distinct from 'object' or
  not(p_input ?& array['catalogVersion','expectedProjectRevision','expectedRevision','ensemble','elements']) or
  p_input-array['catalogVersion','expectedProjectRevision','expectedRevision','ensemble','elements']<>'{}' or
  jsonb_typeof(p_input->'expectedRevision') is distinct from 'number' or
  jsonb_typeof(p_input->'expectedProjectRevision') is distinct from 'number' or
  jsonb_typeof(p_input->'ensemble') is distinct from 'boolean' then
  raise exception 'invalid_inspiration_choices' using errcode='22023';
 end if;
 v_expected:=(p_input->>'expectedRevision')::numeric; v_project_revision:=(p_input->>'expectedProjectRevision')::numeric;
 if v_expected not between 0 and 9007199254740990 or v_expected<>trunc(v_expected) or
  v_project_revision not between 1 and 9007199254740991 or v_project_revision<>trunc(v_project_revision) then
  raise exception 'invalid_inspiration_revision' using errcode='22023';
 end if;
 if v_project_revision<>v_project.current_revision then raise exception 'project_changed' using errcode='PT409'; end if;
 select * into v_catalog from fluid_private.inspiration_catalog where id=p_reference_id;
 if not found then raise exception 'design_not_found' using errcode='P0002'; end if;
 if p_input->>'catalogVersion' is distinct from v_catalog.catalog_version then raise exception 'catalog_changed' using errcode='PT409'; end if;
 v_elements:=fluid_private.reference_elements(p_input->'elements');
 if not(v_elements<@v_catalog.relevant_elements) then raise exception 'irrelevant_element' using errcode='22023'; end if;
 select revision into v_previous from public.project_inspiration_choices
  where project_id=p_project_id and owner_id=v_owner and reference_id=p_reference_id;
 if coalesce(v_previous,0)<>v_expected then raise exception 'choices_changed' using errcode='PT409'; end if;
 insert into public.project_inspiration_heads(project_id,owner_id,revision) values(p_project_id,v_owner,1)
  on conflict(project_id,owner_id) do update set revision=public.project_inspiration_heads.revision+1;
 insert into public.project_inspiration_choices(project_id,owner_id,reference_id,revision,ensemble,elements)
  values(p_project_id,v_owner,p_reference_id,v_expected::bigint+1,(p_input->>'ensemble')::boolean,v_elements)
  on conflict(project_id,owner_id,reference_id) do update set revision=excluded.revision,ensemble=excluded.ensemble,elements=excluded.elements,updated_at=clock_timestamp();
 return public.get_project_inspiration(p_project_id);
end $$;
revoke all on function public.get_project_inspiration(uuid),public.set_project_inspiration_reaction(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.get_project_inspiration(uuid),public.set_project_inspiration_reaction(uuid,uuid,jsonb) to authenticated;

-- Approved catalog descriptors; changing artwork creates a new ID.
insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values('4939a290-80ac-5b7e-8c84-2dbf25079ccd','2026-10-13.1','{"id": "4939a290-80ac-5b7e-8c84-2dbf25079ccd", "slug": "dropbox-blue-symbol", "brand": "Dropbox", "creator": "COLLINS", "kind": "logo", "width": 720, "height": 900, "description": "White Dropbox symbol centered on a saturated blue portrait field.", "sourceUrl": "https://wearecollins.com/case-studies/dropbox/", "elements": ["logo", "colors", "composition"], "tags": ["geometric", "symbol", "blue"], "image": "/inspiration/dropbox-blue-symbol.jpg", "contentHash": "af4aaf96bc48079f937496f5437b6b56b073d8719d327b988c8b0209d2d0934b"}'::jsonb,array['logo','colors','composition']::text[]);
insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values('ea1a8824-6b8c-52c5-bd32-ca747052411c','2026-10-13.1','{"id": "ea1a8824-6b8c-52c5-bd32-ca747052411c", "slug": "inbo-magazine-cover", "brand": "INBO", "creator": "Studio Dumbar/DEPT®", "kind": "identity", "width": 720, "height": 900, "description": "Tilted pink INBO magazine cover with an oversized wordmark and architectural object illustration.", "sourceUrl": "https://studiodumbar.com/work/inbo", "elements": ["logo", "typography", "colors", "graphics", "composition"], "tags": ["editorial", "pink", "architecture"], "image": "/inspiration/inbo-magazine-cover.jpg", "contentHash": "bd3dd464513fb2884615c31907579ab114ad8a0ea7fd7e7bfc044872b5c143a0"}'::jsonb,array['logo','typography','colors','graphics','composition']::text[]);
insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values('d59dcd6a-da18-5402-bb88-d16d9a7dfa06','2026-10-13.1','{"id": "d59dcd6a-da18-5402-bb88-d16d9a7dfa06", "slug": "mastercard-circles", "brand": "Mastercard", "creator": "Pentagram", "kind": "logo", "width": 640, "height": 480, "description": "Red and yellow overlapping Mastercard circles on black.", "sourceUrl": "https://www.pentagram.com/work/mastercard", "elements": ["logo", "colors", "composition"], "tags": ["geometric", "symbol", "circles"], "image": "/inspiration/mastercard-circles.jpg", "contentHash": "68eb9d04286c11c02306b4a78b05088af30c74e3f5c1ed00c1a029e22c9faf39"}'::jsonb,array['logo','colors','composition']::text[]);
insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values('25a42921-164b-556b-a98d-e58b5ce53f8f','2026-10-13.1','{"id": "25a42921-164b-556b-a98d-e58b5ce53f8f", "slug": "dropbox-color-posters", "brand": "Dropbox", "creator": "COLLINS", "kind": "identity", "width": 720, "height": 480, "description": "Dropbox campaign posters combine vivid color pairs, bold typography, the symbol, and expressive photography.", "sourceUrl": "https://wearecollins.com/case-studies/dropbox/", "elements": ["logo", "typography", "colors", "images", "composition"], "tags": ["poster", "bold", "color"], "image": "/inspiration/dropbox-color-posters.jpg", "contentHash": "a39e2b35495e6449caa1152112f1f8aaa44a5bb68989a765697f3034d3a6eb56"}'::jsonb,array['logo','typography','colors','images','composition']::text[]);
insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values('fb3d1c41-d63a-520b-8bae-e8e5110026b1','2026-10-13.1','{"id": "fb3d1c41-d63a-520b-8bae-e8e5110026b1", "slug": "cardless-red-hoodie", "brand": "Cardless", "creator": "Pentagram", "kind": "identity", "width": 640, "height": 781, "description": "Red Cardless hoodie carries an oversized diagonal white symbol and vertical wordmark.", "sourceUrl": "https://www.pentagram.com/work/cardless", "elements": ["logo", "typography", "colors", "composition"], "tags": ["apparel", "red", "symbol"], "image": "/inspiration/cardless-red-hoodie.jpg", "contentHash": "7c9759189051ac73813ab64c506315e1ea6a755aac77c98e37c46488b6c2a19b"}'::jsonb,array['logo','typography','colors','composition']::text[]);
insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values('1415db54-75df-5960-9dc5-bdcecbc17ede','2026-10-13.1','{"id": "1415db54-75df-5960-9dc5-bdcecbc17ede", "slug": "inbo-poster-series", "brand": "INBO", "creator": "Studio Dumbar/DEPT®", "kind": "identity", "width": 720, "height": 405, "description": "Three outdoor INBO posters pair architectural photography with earthy color fields and the broad wordmark.", "sourceUrl": "https://studiodumbar.com/work/inbo", "elements": ["logo", "typography", "colors", "images", "composition"], "tags": ["poster", "architecture", "earthy"], "image": "/inspiration/inbo-poster-series.jpg", "contentHash": "96c1d47e6356bc9e76cecb733e95da96769dfffb0ac11657b20327c60fc268d3"}'::jsonb,array['logo','typography','colors','images','composition']::text[]);
insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values('a052dd6e-dff9-57bd-8c61-e0479fade13c','2026-10-13.1','{"id": "a052dd6e-dff9-57bd-8c61-e0479fade13c", "slug": "dropbox-illuminated-symbol", "brand": "Dropbox", "creator": "COLLINS", "kind": "logo", "width": 720, "height": 960, "description": "An illuminated Dropbox symbol on a deep green wall with a pink architectural surround.", "sourceUrl": "https://wearecollins.com/case-studies/dropbox/", "elements": ["logo", "colors", "composition"], "tags": ["signage", "green", "geometric"], "image": "/inspiration/dropbox-illuminated-symbol.jpg", "contentHash": "97286cf0b943ed04fda9d95621a391a3f7a336a5c8270a45fb3953ba0930446e"}'::jsonb,array['logo','colors','composition']::text[]);
insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values('074a5995-30e7-5336-beb7-8138c6808405','2026-10-13.1','{"id": "074a5995-30e7-5336-beb7-8138c6808405", "slug": "cardless-red-logo", "brand": "Cardless", "creator": "Pentagram", "kind": "logo", "width": 640, "height": 360, "description": "Cardless symbol and wordmark in bright red against a deep red background.", "sourceUrl": "https://www.pentagram.com/work/cardless", "elements": ["logo", "typography", "colors", "composition"], "tags": ["red", "wordmark", "symbol"], "image": "/inspiration/cardless-red-logo.jpg", "contentHash": "f8e9bedbea6b16f99010a4663a3ce82a6a13a820a451f1e871284ffa5be0e23d"}'::jsonb,array['logo','typography','colors','composition']::text[]);
insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values('d4fa4fef-8ee7-584e-a570-95b44528decd','2026-10-13.1','{"id": "d4fa4fef-8ee7-584e-a570-95b44528decd", "slug": "mastercard-stationery", "brand": "Mastercard", "creator": "Pentagram", "kind": "identity", "width": 640, "height": 480, "description": "Dark Mastercard stationery, bag, lanyard, and collateral use circular graphics and restrained color accents.", "sourceUrl": "https://www.pentagram.com/work/mastercard", "elements": ["logo", "typography", "colors", "graphics", "composition"], "tags": ["stationery", "black", "circles"], "image": "/inspiration/mastercard-stationery.jpg", "contentHash": "b4eb2cbcd63254c944f748762f188d78fb1448b5699734e8ecf3c94739777fae"}'::jsonb,array['logo','typography','colors','graphics','composition']::text[]);
insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values('5223e5f8-4c34-521c-b9ae-186a46d5bdfa','2026-10-13.1','{"id": "5223e5f8-4c34-521c-b9ae-186a46d5bdfa", "slug": "into-illuminated-billboard", "brand": "INTO", "creator": "Studio Dumbar/DEPT®", "kind": "identity", "width": 720, "height": 405, "description": "INTO billboard uses a green luminous gradient and stretching letterforms to say Open Your World.", "sourceUrl": "https://studiodumbar.com/work/into", "elements": ["typography", "colors", "graphics", "composition"], "tags": ["green", "gradient", "billboard"], "image": "/inspiration/into-illuminated-billboard.jpg", "contentHash": "2f515102acb6857fa26c1b830da455fa404e506ba17f2d61f3f28ba9a4f2c01f"}'::jsonb,array['typography','colors','graphics','composition']::text[]);
insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values('a8a632f0-f4e5-5b12-a25b-65d3f9c758c4','2026-10-13.1','{"id": "a8a632f0-f4e5-5b12-a25b-65d3f9c758c4", "slug": "inbo-black-tote", "brand": "INBO", "creator": "Studio Dumbar/DEPT®", "kind": "identity", "width": 720, "height": 900, "description": "Black INBO tote with an oversized white architectural wordmark, photographed in use.", "sourceUrl": "https://studiodumbar.com/work/inbo", "elements": ["logo", "typography", "colors", "composition"], "tags": ["apparel", "wordmark", "black"], "image": "/inspiration/inbo-black-tote.jpg", "contentHash": "394b52b335ccd1f353d89c40571ff964c37477db5a8dd535769a995d80b459cb"}'::jsonb,array['logo','typography','colors','composition']::text[]);
insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values('f9aef4e9-6505-593f-b052-d962c43e2e2f','2026-10-13.1','{"id": "f9aef4e9-6505-593f-b052-d962c43e2e2f", "slug": "dropbox-street-posters", "brand": "Dropbox", "creator": "COLLINS", "kind": "identity", "width": 720, "height": 480, "description": "Two Dropbox street posters combine surreal image pairings and strong typographic blocks.", "sourceUrl": "https://wearecollins.com/case-studies/dropbox/", "elements": ["typography", "colors", "images", "composition"], "tags": ["poster", "photography", "editorial"], "image": "/inspiration/dropbox-street-posters.jpg", "contentHash": "b950819cbea17a3c49295444bf6af0e35afc38233b968b7cc8579afa79a05f05"}'::jsonb,array['typography','colors','images','composition']::text[]);
insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values('7481512a-89c7-5766-93be-5eab15f27dee','2026-10-13.1','{"id": "7481512a-89c7-5766-93be-5eab15f27dee", "slug": "cardless-credit-card", "brand": "Cardless", "creator": "Pentagram", "kind": "identity", "width": 640, "height": 360, "description": "A red fluid-texture Cardless credit card on a dark surface, with the mark and name.", "sourceUrl": "https://www.pentagram.com/work/cardless", "elements": ["logo", "typography", "colors", "graphics", "composition"], "tags": ["red", "texture", "card"], "image": "/inspiration/cardless-credit-card.jpg", "contentHash": "63cb494a94d15e73e1f8ee9365a2ad08b5b932829e8e1bcc0c3e71c1cd9acb9d"}'::jsonb,array['logo','typography','colors','graphics','composition']::text[]);
insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values('e170e2c4-e2ad-5b24-b97f-107ed5bbde99','2026-10-13.1','{"id": "e170e2c4-e2ad-5b24-b97f-107ed5bbde99", "slug": "mastercard-brochures", "brand": "Mastercard", "creator": "Pentagram", "kind": "identity", "width": 640, "height": 480, "description": "Two Mastercard brochures combine warm color blocks, circular graphics, and editorial typography.", "sourceUrl": "https://www.pentagram.com/work/mastercard", "elements": ["logo", "typography", "colors", "graphics", "composition"], "tags": ["editorial", "circles", "warm"], "image": "/inspiration/mastercard-brochures.jpg", "contentHash": "c58b70d6cd456f7d9810285314824b46de899ad7a499e50fa706455963d1da05"}'::jsonb,array['logo','typography','colors','graphics','composition']::text[]);
insert into fluid_private.inspiration_catalog(id,catalog_version,descriptor,relevant_elements) values('2d91f3b8-de32-5f86-8451-a0689d68e768','2026-10-13.1','{"id": "2d91f3b8-de32-5f86-8451-a0689d68e768", "slug": "dropbox-color-guide", "brand": "Dropbox", "creator": "COLLINS", "kind": "identity", "width": 720, "height": 480, "description": "An open Dropbox brand guide showing color-pair diagrams and large editorial typography.", "sourceUrl": "https://wearecollins.com/case-studies/dropbox/", "elements": ["typography", "colors", "graphics", "composition"], "tags": ["guide", "editorial", "palette"], "image": "/inspiration/dropbox-color-guide.jpg", "contentHash": "ec588cb0d218a8aabd490fc1516c56ed6c8c5e8ddc591426a5a3c01c80a4b25e"}'::jsonb,array['typography','colors','graphics','composition']::text[]);
commit;
