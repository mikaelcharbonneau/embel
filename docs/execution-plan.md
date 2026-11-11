# Execution plan: finishing the architecture work

Approved November 10, 2026. This records how the remaining work in
`docs/architecture-review.md` gets done with parallel helper agents, and where each task stands today.
It follows Anthropic's guide
["Which Claude model should you build with"](https://claude.dev/blog/which-claude-model-should-you-build-with/)
by Addy Osmani (November 9, 2026).

## Principles

| Rule | Why |
|---|---|
| The lead runs Opus 5.5 at medium effort. It reviews, merges and does every production release. | One careful reviewer keeps production safe. |
| At most 3 helpers write code at once, each on different files. | Helpers working on the same files undo each other's work. |
| Haiku 5.5 handles search, log reading and mapping. | Cheap and fast for work that changes nothing. |
| Sonnet 5.5 handles well-scoped coding. | Good value when the task is clear. |
| Opus 5.5 handles complex or risky work. | Security, money and data deletion deserve the stronger model. |
| Fable 5.2 handles major migrations. | Reserved for large, delicate rewrites. |
| Raise reasoning effort before switching to a bigger model. | Often fixes the problem at a lower price. |
| Helpers never touch production. | Only the lead releases, after review. |

## Waves and tasks

Status as of November 10, 2026. Waves C and D are unchanged.

### Wave A: finish and protect what shipped

| Task | Model, effort | Status |
|---|---|---|
| A1 Logo release | lead | done |
| A2 Creative directions | Opus, high | done (#228) |
| A3 DB hardening | Sonnet, high | done (#225) |
| A4 Rate limits and BotID | Sonnet, medium | done (#224); WAF rules pending owner |
| A5 CAPTCHA | Sonnet, medium | done (#226), off |
| A6 Journey e2e in CI | Opus, medium | done |
| A7 Old-worker map | Haiku | done |

### Wave B: retire the old system and clean up

| Task | Model, effort | Status |
|---|---|---|
| B1 Retire old worker code | Opus, high | done (#231) |
| B2 Drop old tables, functions, logins | Opus, high | done (#233), applied in production |
| B3 Baseline migration matching production | Fable 5.2, medium | done (#235) |
| B4 CI builds the DB and applies migrations | Sonnet, high | done (#236); release workflow inert until the owner adds secrets |
| B5 Account deletion and data export | Opus, high | done (#234), live |
| B6 Dead code, switches, Node 24, formatter | Sonnet, medium | done (#237); formatter pass still to do |
| B7 README and docs | Sonnet, medium | done (#238); AGENTS.md updated November 11 ([suggestions, archived](archive/agents-md-suggestions.md)) |

### Wave C: launch needs

| Task | Model, effort | Status |
|---|---|---|
| C1 Payments with a merchant of record | Opus, high | live in the Stripe sandbox (#244, #245); switch to live keys at launch ([payments.md](payments.md)) |
| C2 Plans page | Sonnet, medium | live (`/plans`), with Cancel plan (#245) |
| C3 Staging DB | Sonnet, medium | project `embel-staging` created (Nov 11); schema and preview switch need the owner's DB password or CLI login |
| C4 Email sender | lead guides owner | done: Resend via Supabase, branded emails (#242) |
| C5 Sentry | Sonnet, medium | postponed by owner |

### Wave D: pre-launch checks

| Task | Model, effort | Status |
|---|---|---|
| D Pre-launch: abuse test | Opus, high | done (#239); one hole fixed |
| D Pre-launch: payment test mode | Sonnet, medium | done Nov 11: checkout, upgrade, downgrade, re-upgrade, cancel, end (local app, sandbox) |
| D Pre-launch: backup restore drill | lead | with the owner present (dashboard-only; a mis-click could restore over production) |
| D Pre-launch: raise the $50/day cap | lead | — |

## Dependencies

```
B1 → B2 → B3
        └→ B5
B4, B6, B7 run alongside
```

- B2 waits for B1, because old tables can only go once nothing uses them.
- B3 and B5 wait for B2, because both depend on the final list of tables.
- B4, B6 and B7 touch different files and can run at the same time as the others, within the limit of 3
  helpers writing code.

## Cost tips

- Keep the lead's context lean: ask helpers for short reports and put long findings in files.
- For checkable tasks (tests, searches, mappings), run at low effort first and re-run only the failures at
  high effort.
- Raise effort before switching to a bigger model.
