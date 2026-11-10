-- Strategy on the generation engine (docs/generation-engine.md, step 2).
-- Additive only: six generation kinds, one per Strategy operation in
-- src/domain/strategy-jobs.ts. Each costs one credit. They start disabled:
-- enabling all six together is a release decision, and the app keeps the old
-- Strategy path until every one of them is enabled.
-- Daily limits are per owner and kind. Research runs web searches, so it is
-- held lower; a reply to a message is the most frequent request.
insert into fluid_private.generation_kinds (kind, credits, enabled, max_per_day) values
  ('strategy.reformulate', 1, false, 100),
  ('strategy.competitors', 1, false, 20),
  ('strategy.audience', 1, false, 40),
  ('strategy.positioning', 1, false, 40),
  ('strategy.personality', 1, false, 40),
  ('strategy.slogan', 1, false, 40)
on conflict (kind) do nothing;
