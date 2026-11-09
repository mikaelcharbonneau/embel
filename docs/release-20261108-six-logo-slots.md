# Six parallel Logo slots — November 8, 2026

A six-concept logo batch is six jobs, but production had one Logo slot, so the
concepts generated one after another. This release adds five Logo slots, so the
six jobs of one batch can run at the same time. It required a full rotation of
the worker's credentials, because the existing credentials setting cannot be
read back and every slot must be in it.

Code: #201 (`d6fca34270626a4f02e07095ded517ab315b1676`). The production rule now
allows one Strategy slot, one Naming slot and one to six Logo slots, and the
worker has 2 GB of memory instead of 1 GB. The website is unchanged.

## What went live

| Resource | Released | Previous |
| --- | --- | --- |
| Shared-worker deployment | `dpl_tHqm93TWe2NVKoSDGGE5WNJcRumf` | `dpl_9DLrYAdNvMoYpa1NxBLMP4YPyeyz` (`029ff49`) |
| Worker artifact SHA-256 | `f973cadaf2e8b20d488363ba18815ec7807efc308ded64021cc3c217de21264b` | `caa834097a7593b1c76ff5718ead85eb216e682e5e0f2326c88044dcd481f98e` |
| Worker configuration SHA-256 | `3d008ff13cc6b0eef9f227c8876e78ceb4fd60ee34c3965165a17d64001d8627` (17,167 bytes) | `d3704e6a22b5cd33c2b3214cf0789eba18f2a518a722e560bd22d6fab07aff6a` (10,662 bytes) |
| Worker credentials setting | Rewritten (sensitive, never read back) | Unreadable; its passwords no longer work |
| Database transaction | SHA-256 `ca971993b0c55937ebb94db2da779c9a5c02afbbf3fa4819b0d2d7893bf39eb3` | — |
| Rollover receipt | `41a89136-389f-40f0-b07d-62fe43fd0ca2` (scope `embel-release-20261108-six-logo-slots`, 8 slots) | `f7c7020e-900c-478e-82b6-279343954935` |
| Naming owner binding | revision 15, `8c6d1835-037f-4a8e-a129-c03b70e7e2a6` (approval `2e21bd7c-e3b5-4fbb-ae37-7b30337cdbb1`) | revision 14, `068d21f0-6b37-40c0-b77e-45f3fc92f617` |

New Logo slots (all on the new deployment, per-person limit 6):

| Slot | Slot ID | Database role (OID) | Storage service user |
| --- | --- | --- | --- |
| 2 | `b8b84029-0709-4629-a8c9-d1e69386222c` | `embel_shared_logo_prod_s2` (32652) | `dd4026cc-eac6-4e06-903e-aef85ff73fa7` |
| 3 | `f0aa6563-ead4-4ec2-92ae-423f5dc8d4d0` | `embel_shared_logo_prod_s3` (32655) | `aedf7895-4132-4c44-9a8a-c44b4bd7171d` |
| 4 | `b8c4aa8f-808e-4c26-9c1d-b7bf1393cfe8` | `embel_shared_logo_prod_s4` (32658) | `05e6a20f-821c-4ac5-8035-4ca55451c5be` |
| 5 | `ca868de9-2f8b-46b4-83b5-41a22ae4ab3d` | `embel_shared_logo_prod_s5` (32661) | `cc55862c-d375-4657-b62d-50cdb3543f1f` |
| 6 | `7316244d-8ab6-4d3c-9594-d6203623f2f7` | `embel_shared_logo_prod_s6` (32664) | `86aacd9e-30c2-45ac-9ac5-4aece2755d59` |

Slots 2–6 copy Logo slot 1's `identity.logo_concept` and `identity.logo_refine`
policies exactly. Slot 1 keeps all seven Logo and Identity operations, so
vectors, exports, directions and brand images still run one at a time there. The
Storage service users use `embel-logo-storage-s<n>@embel.xyz` addresses; no email
is sent to them.

## Credentials

- New passwords for all eight database roles and all six Storage service users,
  generated in memory (256-bit random) and never printed, logged or saved.
- The database received only SCRAM-SHA-256 verifiers, never a password. The pg
  client's own SCRAM code was checked against the verifier format beforehand.
- Every AI provider in the credentials setting references the worker project's
  existing `OPENAI_API_KEY` (`apiKeyEnvironment`), so no AI key was copied.
- The new Storage users were created unconfirmed and without a password,
  registered as service actors, and confirmed only afterwards, as the database
  requires.

## Database

One guarded owner transaction, rehearsed first with a forced rollback:

1. Locked the slot, policy and service-actor tables (exclusive) and the job,
   accounting, account and Naming tables (share), hashed the protected tables,
   and checked the drain: no live leases, no unfinished executions, no active
   jobs.
2. Required the registry to be exactly the three original slots (or this plan's
   eight, for a retry).
3. Set new password verifiers on the three existing roles.
4. Created five Logo roles with the same attributes and the same seven function
   grants as Logo slot 1, registered their slots, copied the two policies, and
   registered their Storage service users.
5. Set the per-person limit to 6 on all eight slots.
6. Refused to commit unless there were eight enabled slots, Logo slots 1–6,
   uniform limits, safe roles, matching grants and policies, six Storage users,
   unchanged existing slots, and unchanged protected tables.

The same SQL passed a local rehearsal on the disposable database first,
including a retry that converged to the same state and refusals for a live
lease, a missing protected table and an unplanned slot.

## Sequence (UTC)

1. Merged #201 after CI passed. Built the stopped worker package from a clean
   `main` (`npm ci`, empty `git status`). In a Linux x64 Node 22.22.2 container
   with networking disabled, `--describe` and `--native-smoke` passed all seven
   native checks over 2,023 files.
2. Scaled the worker to 0 at 23:21:54; drained by 23:22:03.
3. Created the five unconfirmed Storage service users at about 23:23.
4. 23:24:08–23:24:41: database rehearsal and transaction; Storage passwords and
   confirmations; both settings checked by the worker's own readers; all eight
   slots passed the worker's own database qualification through the pooler with
   the new passwords; all six Storage users signed in (and out); both settings
   written, and the configuration read back exactly.
5. Uploaded the worker deployment at zero instances (READY by 23:25:29).
6. Rehearsed and appended rollover receipt `41a89136…` at 23:26:10. It moved
   exactly eight slot `deployment_id` values, with identical protected-table
   hashes.
7. Scaled to one instance at 23:26:26. By 23:26:38 one instance held all eight
   leases, all six Logo slots reported runtime readiness and all six Storage
   users were verified for the current generation. The worker was stopped for
   about 4½ minutes.
8. Naming readiness kept its fingerprint and policy. Approval `2e21bd7c…` and
   `shared_naming_adopt_existing` appended revision 15 at 23:27:09, keeping
   revision 14.

## Verification and limits

- CI passed on #201. New tests cover six Logo jobs running at once in the
  worker and in SQL, a per-person limit of six holding a seventh, and the
  production rule (up to six Logo slots, refusing a seventh or a second Naming
  or Strategy slot).
- After release, the worker log shows only its startup event and the same
  certificate-directory notices as the previous deployment, with no
  `shared_worker_pool_diagnostic` entries; leases keep renewing.
- Not yet observed: six concepts actually running at once in production. That
  needs one real concept batch from a signed-in account; the database records
  each execution, so the overlap can be confirmed afterwards.
- The AI provider reference assumes the worker project's `OPENAI_API_KEY` is the
  key the lanes used before. If a lane reports an authentication failure, that
  key needs replacing in the worker project.
- Worker memory under six simultaneous concepts has not been measured; the
  instance now has 2 GB.

## Rollback

- The previous credentials no longer work, and the previous worker code accepts
  only three slots. Any rollback is therefore another stopped window with a new
  credential rotation, not a one-step revert.
- **Back to one Logo slot:** with the worker stopped and drained, disable slots
  2–6 and set the per-person limit back to 1 in one guarded transaction, write a
  three-slot configuration and a three-slot credentials setting with freshly
  rotated passwords, then deploy and roll over as above. The five roles, slots
  and Storage users can stay disabled; they grant nothing.
- **Worker code only:** promoting `dpl_9DLrYAdNvMoYpa1NxBLMP4YPyeyz` requires the
  three-slot shape above first.
