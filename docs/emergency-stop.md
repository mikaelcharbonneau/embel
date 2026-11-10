# Emergency stop: AI generation

Use this when spending looks wrong or generations misbehave. All AI steps run on the generation
engine inside the web app ([generation-engine.md](generation-engine.md)), so the stop is a database
switch. The website, sign-in and downloads keep working.

Run these in the Supabase SQL editor of the production project.

## Stop everything

```sql
update fluid_private.engine_settings set paused = true;
```

New requests are refused, and running ones stop before their next paid call. A call already sent to
OpenAI may still finish and be billed.

## Start again

```sql
update fluid_private.engine_settings set paused = false;
```

## Stop one step only

Each engine kind has its own switch. For example, to stop logo drawing:

```sql
update fluid_private.generation_kinds set enabled = false where kind like 'logo.%';
```

Set `enabled = true` to turn it back on. With a kind off, its step shows as unavailable to people;
saved results stay. The kinds are `strategy.*`, `naming.generate`, `logo.concepts`, `logo.refine`,
`logo.style_note` and `identity.directions`.

## Check

```sql
select paused from fluid_private.engine_settings;
select kind, enabled from fluid_private.generation_kinds order by kind;
select kind, status, count(*) from public.generation_runs
where status in ('queued', 'running') group by 1, 2;
```

Runs left over after a stop end on their own: the engine checks for a pause before every paid step,
and overdue runs are ended with a refund the next time their owner starts or cancels a run.

## Money backstop

In the OpenAI dashboard, set a monthly budget and email alerts for the project that holds the
production key. It caps spending even if nobody runs the stop above. The engine also has a global
daily cost cap inside `start_generation`.
