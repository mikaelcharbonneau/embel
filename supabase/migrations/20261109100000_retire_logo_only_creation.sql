-- Every project is a complete brand (November 9, 2026). The Logo step now only
-- opens inside an existing project, so the old way to start a logo-only
-- ("Visual identity") project, and the two readers that recovered an
-- unconfirmed start, are no longer available to signed-in users.
--
-- The functions themselves are left exactly as they are. Local development
-- databases compare function bodies and constraints with their installation,
-- so dropping or rewriting them would force every local database to be
-- rebuilt. Role grants are not part of that comparison. Existing projects keep
-- their Logo work, which stays readable through the project's Logo workspace.
begin;
set local lock_timeout = '2s';

revoke execute on function
  public.start_logo_project(jsonb),
  public.read_logo_project_creation(uuid),
  public.list_logo_project_creations(jsonb)
from public, anon, authenticated;

do $$
declare signature text;
begin
  foreach signature in array array[
    'public.start_logo_project(jsonb)',
    'public.read_logo_project_creation(uuid)',
    'public.list_logo_project_creations(jsonb)'] loop
    if has_function_privilege('authenticated', signature, 'EXECUTE')
      or has_function_privilege('anon', signature, 'EXECUTE') then
      raise exception 'logo_only_creation_still_callable: %', signature;
    end if;
  end loop;
end $$;
commit;
