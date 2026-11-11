-- Competitor research costs 2 credits (owner decision, November 11, 2026).
--
-- A real full brand measured on November 11 put competitor research at about $0.054 per
-- run, the most expensive step per credit together with Creative directions ($0.053 per
-- credit at 6 credits), while the other text steps cost $0.03-$0.04 and names $0.006. It is
-- also the step people repeat most. At 2 credits it costs about $0.027 per credit.
--
-- Text runs keep their full credits when they succeed and are refunded when they fail,
-- using each run's own recorded credits, so runs admitted at 1 credit finish unchanged.
--
-- Rollback: set the credits of strategy.competitors back to 1.

begin;

update fluid_private.generation_kinds set credits = 2 where kind = 'strategy.competitors';

commit;
