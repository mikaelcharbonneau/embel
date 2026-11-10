/** Mirrors shared_image_model_2_6.sql for fixtures that install an earlier
 * subset of the shared packets, whose function versions the packet's
 * predecessor guards would refuse: new admissions require 2.6, a stored raster
 * response stays valid under either model, and a newly recorded raster
 * response or board receipt must name its job's admitted model. Each edit
 * applies only where that version contains the edited fragment. */
const admitted = "(select a.policy->>'model' from fluid_private.shared_job_admissions a where a.job_id=j.id)";
const EDITS: readonly (readonly [name: string, needle: string, replacement: string])[] = [
  ["shared_logo_raster_policy_valid", "'gpt-image-2.5-sunburst-2026-09-08'", "'gpt-image-2.6-sunburst'"],
  ["shared_identity_policy_valid", "'gpt-image-2.5-sunburst-2026-09-08'", "'gpt-image-2.6-sunburst'"],
  ["get_shared_identity_availability", "'gpt-image-2.5-sunburst-2026-09-08'", "'gpt-image-2.6-sunburst'"],
  ["shared_logo_raster_observation_valid", "o->>'model' is distinct from 'gpt-image-2.5-sunburst-2026-09-08'",
    "(o->>'model' in('gpt-image-2.6-sunburst','gpt-image-2.5-sunburst-2026-09-08')) is not true"],
  ["shared_logo_record_response", "fluid_private.shared_logo_raster_observation_valid(o)",
    `(fluid_private.shared_logo_raster_observation_valid(o) and o->>'model' is not distinct from ${admitted})`],
  ["shared_identity_receipt_complete", "o->>'model'<>'gpt-image-2.5-sunburst-2026-09-08'", `o->>'model' is distinct from ${admitted}`],
];
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export async function applySharedImageModel(db: { exec(sql: string): Promise<unknown> }): Promise<void> {
  await db.exec(`do $$ declare fn regprocedure; body text; edit text[]; begin
   foreach edit slice 1 in array array[${EDITS.map(([name, needle, replacement]) => `array[${literal(name)},${literal(needle)},${literal(replacement)}]`).join(",")}] loop
    for fn, body in select p.oid::regprocedure, p.prosrc from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
     where n.nspname in('public','fluid_private') and p.proname=edit[1] and strpos(p.prosrc,edit[2])>0 loop
     execute replace(pg_catalog.pg_get_functiondef(fn),body,replace(body,edit[2],edit[3]));
    end loop;
   end loop; end $$;`);
}
