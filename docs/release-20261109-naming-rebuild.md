> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# Naming rebuild and two Logo slots — November 9, 2026

Naming generation kept failing. On November 9 a NUL character in one AI reply
could not be stored. The old engine treated that as an unknown paid outcome,
and recovery repeated it on every restart until the worker stopped, taking
Strategy and Logo with it. Separately, eight worker slots overloaded the Free
plan database (0.5 GB). This release:

- replaces Naming generation with one simple background job;
- removes the old Naming engines;
- stops one lane's failure from stopping the others;
- runs the worker with two Logo slots instead of six.

The Supabase plan stays Free, by the owner's choice.

Code on `main` (`6bb2d36a6d50e7544c78c66811c7f8ed48359598`):

- #205: lane isolation;
- #202: local six-slot tooling (local development keeps six Logo slots);
- #208 → #207 → #203: the complete-brand change, the Naming rebuild and the
  removal of the old engines.

## What went live

| Resource | Released | Previous |
| --- | --- | --- |
| Website deployment | `dpl_F79SgeeDVVQMvbvJtrYSUMLDJcS5` (`6bb2d36`) | `dpl_Gude2D7r7cDiPSkH1hdKMXbArHhZ` (`f475fcd`) |
| Shared-worker deployment | `dpl_AFDpYngKDbaPu49VFMz5fAo9B7ux` | `dpl_tHqm93TWe2NVKoSDGGE5WNJcRumf` |
| Worker artifact SHA-256 | `4b37bc7020f1e2169417d17ee49d37c504370c488ad72b8d4b7c7bb68ddcb544` | `f973cadaf2e8b20d488363ba18815ec7807efc308ded64021cc3c217de21264b` |
| Worker configuration SHA-256 | `7b8ccc51e87f6422…` (11,187 bytes, 4 slots) | `3d008ff13cc6b0ee…` (17,167 bytes, 8 slots) |
| Worker credentials setting | Rewritten (sensitive, never read back) | Its passwords no longer work |
| Slot transaction | Shape SHA-256 `2e50dcd89a4fae872e3294603fab9aaf5f424fb3f53d3755cb611ed119da17bc` | — |
| Rollover receipt | `02aa7b41-2ae8-4744-af0f-37f16cb79fd5` (scope `embel-release-20261109-naming-rebuild-two-logo-slots`, 4 slots) | `41a89136-389f-40f0-b07d-62fe43fd0ca2` |

**Database changes**, each recorded in `supabase_migrations.schema_migrations`:

| Version | Name | Effect |
| --- | --- | --- |
| `20261109090000` | `complete_brand_only` | 16 projects converted; all 71 are now complete brands |
| `20261109100000` | `shared_naming_generation_20261109` | The new run, round and feed functions; the Naming gateway replaced in place |
| `20261109100500` | `shared_naming_cleanup_20261109` | See below |

The cleanup packet left:

- 33 Naming functions (from 177) and no old Naming tables;
- no old batches or generated names; the 5 names people added themselves were kept;
- no old Naming job open.

**Worker shape:**

| Lane | Slots | Notes |
| --- | --- | --- |
| Strategy | 1 | — |
| Naming | 1 | New policy `{version: 2, operation: "naming.generate", model: "gpt-6-luna", reasoningEffort: "low"}` |
| Logo | 2 | Slot 1 `b775e7b1…` keeps all seven Logo and Identity operations; slot 2 `b8b84029…` does concepts and refinements |

- The per-person limit is 2 on every enabled slot.
- Logo slots 3–6 (`f0aa6563…`, `b8c4aa8f…`, `ca868de9…`, `7316244d…`) and their Storage service users are disabled. Their roles and users remain but grant nothing.

## Credentials

- New 256-bit passwords for the four enabled database roles and the two Logo
  Storage users, generated in memory and never printed, logged or saved.
- The database received only SCRAM-SHA-256 verifiers.
- All four slots passed the released worker's own database qualification
  through the pooler before the settings were written.
- Both Storage users signed in, then out.
- AI providers still reference the worker project's `OPENAI_API_KEY`.

## Sequence (UTC, November 9)

1. Read-only checks: no leases, executions or active jobs. All 19 function
   bodies the cleanup rewrites matched their reviewed versions.
2. `complete_brand_only` and the generation packet: each rehearsed with a forced
   rollback, then applied. The website still running then kept working.
3. CI passed on every PR. Merged #205, #202, #208, #207, then #203.
4. 04:41:48–04:43:46: deployed the website from a clean clone of `6bb2d36`.
5. About 04:44: cleanup packet rehearsed, then applied.
6. Built and packaged the stopped worker from the same clean clone. In a Linux
   x64 Node 22.22.2 container with networking disabled, `--describe` matched
   the revision and artifact, and `--native-smoke` passed all seven native
   checks over 2,023 files.
7. 04:45:12–04:45:38: slot transaction (rehearsed, then applied), Storage
   passwords, qualification of all four slots, Storage sign-ins, and both
   settings written. The configuration was read back exactly.
8. 04:45:49–04:46:15: worker deployment uploaded at zero instances.
9. 04:46:32: rollover rehearsed, then applied. It moved exactly the four enabled
   slots, with identical protected-table hashes.
10. 04:46:39: scaled to one instance. By 04:46:47 that instance held all four
    leases, with both Logo slots ready, Naming ready and both Storage users
    verified for the current generation.

## Verification and limits

- **Before release:**
  - Locally: the full journey, 100 names in about 61 s, a mid-round worker
    restart resumed by polling, Stop, steering, a like, choosing a name and
    the Slogan handoff.
  - The full packet chain installed on native PostgreSQL 17 as NOSUPER.
- **After release:**
  - 33 of 60 database connections in use (the worker held 5).
  - The website and sign-in page return 200. The Auth service answered in
    under 0.1 s; during the overload it was timing out.
  - The worker log shows only its startup event and the same certificate
    notices as earlier deployments.
- **Not yet observed in production:**
  - A real Naming run (needs a signed-in account).
  - Logo concepts with two slots.
  - Database memory under a concept batch: it is no longer swapping at idle,
    but has not been checked under load.

## Rollback

- **Stop the worker:** `vercel daemons scale shared-worker iad1=0` on the worker
  project. Runs already started end as `lease_expired` or `send_interrupted`
  when a worker next runs. They are never re-sent automatically.
- **More Logo slots again:** another stopped window with a fresh credential
  rotation: enable slots, set the limit, write the settings, then roll over.
- **The database changes are forward-only.** The old Naming functions and tables
  are gone, so the previous website and worker cannot run Naming against this
  database. Other features would work after a website rollback.
