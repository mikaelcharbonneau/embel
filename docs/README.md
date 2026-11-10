# Documentation index

Current documents only. Everything dated before the generation engine (November 10, 2026) is in
[archive](archive/) and carries no authority: old plans, handoffs, release notes, per-screen design
notes and decisions for systems that no longer exist. [AGENTS.md](../AGENTS.md) is the owner's working
agreement and has the final say. If a document and the code disagree, the code is right; please fix
the document.

## Start here

- [architecture.md](architecture.md): short map of the system and how one AI request flows.
- [generation-engine.md](generation-engine.md): how AI runs: workflows, credits, limits, per-step notes.
- [environment-variables.md](environment-variables.md): every variable the app reads, and where it is set.

## Plans and status

- [architecture-review.md](architecture-review.md): the November 9 review (issues S1 to S12, M1 and
  others) and the plan it led to.
- [execution-plan.md](execution-plan.md): who does which remaining task, and where each stands.
- [agents-md-suggestions.md](agents-md-suggestions.md): proposed edits to AGENTS.md, waiting for the owner.
- [brand-journey-redesign-plan-20261106.md](brand-journey-redesign-plan-20261106.md): the current
  interface design (floating pill navigation, neutral ink accent).

## Operations and releases

- [emergency-stop.md](emergency-stop.md): stop AI spending fast, for everything or one step.
- [database-release.md](database-release.md): how database changes reach production, and what CI checks.
- [baseline-release.md](baseline-release.md): the one-time step that recorded the baseline migration.
- [security-rate-limits.md](security-rate-limits.md): BotID and WAF rate limits on paid AI routes.
- [auth-captcha.md](auth-captcha.md): the Turnstile CAPTCHA on sign-up, sign-in and password reset (off until keyed).

## Accounts and data

- [account-creation.md](account-creation.md): sign-up, email confirmation and the callback.
- [account-profile-settings.md](account-profile-settings.md): name, time zone and date format.
- [account-deletion.md](account-deletion.md): deleting an account and exporting its data.
- [project-deletion.md](project-deletion.md): recoverable project deletion (the lock and job sections are historical).
- [recoverable-error-boundaries.md](recoverable-error-boundaries.md): what shows when a screen fails to render.

## Brand and product references

- [logo-style-notes.md](logo-style-notes.md): how liked logos shape logo concepts.
- [inspiration-brand-boards.md](inspiration-brand-boards.md): the sourcing brief for the Inspiration boards.
- [embel-branding.md](embel-branding.md): the Fluid to Embel rename and what kept its old name.
- [references.md](references.md) and [references/](references/): provenance and licenses of outside references.
