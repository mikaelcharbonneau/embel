# Account deletion and data export

_November 10, 2026. Task B5 of `docs/execution-plan.md`, issue M9 of `docs/architecture-review.md`._

## What the person sees

Settings → Account → **Your data** has two rows:

- **Download my data**: one click downloads `embel-data-YYYY-MM-DD.zip`. Three downloads per
  account per day.
- **Delete account**: opens a dialog that explains what is removed and asks the person to type
  their email. **Delete account** in the dialog deletes everything. Deleting needs a sign-in from
  the last 15 minutes; otherwise the dialog asks the person to sign in again first. When it
  finishes, the browser is signed out and returns to Home.

## Deletion

`POST /api/account/deletion` (same origin, `X-Embel-Account`, body `{ "confirmEmail": "…" }`). The
account always comes from the verified session; no request field can name another account.

Steps, each safe to repeat:

1. Check the typed email and the session's sign-in time (the `amr` timestamp in the access token).
2. Ask running and queued generations to stop, with the person's own login (`cancel_generation`).
3. `account_deletion_begin`: open (or reopen) the deletion receipt.
4. `account_deletion_purge`: one database transaction that copies the accounting amounts (below),
   then deletes every row with the person's `owner_id` (or `auth_user_id`) in the `public` and
   `fluid_private` schemas, plus rows of tables without an owner column that point at them. It
   takes the same per-account lock as `start_generation`, so no run is admitted mid-purge.
5. Delete every Storage object under `<account id>/` through the Storage API, 100 at a time,
   always listing from the start so an interrupted run resumes with what is left.
6. Delete the Auth user through the Auth admin API (already gone counts as done).
7. `account_deletion_complete`: close the receipt and forget the account id.

If any step fails the person sees "Deletion didn't finish… Try again to finish it." The receipt stays
pending. Trying again, or the cleanup job below, continues from where it stopped.

The server uses the project's secret API key (`EMBEL_ENGINE_SUPABASE_SECRET_KEY`, or
`EMBEL_ACCOUNT_ADMIN_SECRET_KEY` if set). It is read only in `src/server/account/admin.ts`, which is
`server-only`.

### History stays unchangeable in normal operation

The history triggers (`prevent_history_change` and eleven other functions) refuse DELETE. The
migration gives each such row trigger a `WHEN` condition: it still fires for every DELETE except
inside the transaction that `account_deletion_purge` opened, recognised by a row in
`fluid_private.account_purge_transactions` keyed by that transaction's id. Only the purge function
writes that table, and the row is removed before it commits. Setting the transaction setting by hand
is not enough, and an API role that tries gets a permission error. Triggers that also fire on INSERT
or UPDATE are split: the original name keeps those events unchanged, and `<name>_on_delete` carries
DELETE with the condition. Trigger function bodies are not changed, so the hashes reviewed in
`scripts/development/shared-authority-manifest.json` still hold. The migration fails if any DELETE
row trigger on these schemas is left without the condition and uses an unreviewed function, so a new
blocker is caught when it is applied.

Foreign keys to `auth.users` are unchanged. Tables without `on delete cascade` keep refusing a raw
Auth deletion while the person still has data, so an account can only disappear through the purge.

### What is kept, and why

| Kept | Where | Contents |
|---|---|---|
| Deletion receipt | `fluid_private.account_deletion_receipts` | Random receipt id, a SHA-256 of the account id (support can confirm a deletion when given the id; the receipt never names anyone), state, attempt count, times, numbers of rows and files deleted. |
| Usage for accounting | `fluid_private.deleted_account_usage` | Per credit entry: kind, amount, time. Per generation: kind, status, credits, provider cost, start and finish time. Per older-system job with a recorded provider cost: operation, state, cost, times. Linked only to the receipt id. |

No user id, email, project, input, output, file name or free text is kept. Everything else the
person owned is deleted, including request logs, export requests and the disabled
`shared_accounts` row the production Auth trigger writes when the user is deleted.

## Data export

`POST /api/account/export` (same origin, `X-Embel-Account`, body `{}`) streams a ZIP:

- `account.json`: id, email and profile settings.
- `data/<table>.json`: every row the person owns in each `public` table that has an `owner_id`
  column and that the signed-in role may read (`account_export_tables`). Rows are read with the
  person's own login, so row security decides what is included. Internal fields (provider costs,
  leases, workflow and idempotency ids, internal plans, `sent.*` engine markers) are left out.
- `files/…`: the person's Storage objects, with an extension from their type.
- `files.json`: every file, and for any not included, why.

**Why a streamed ZIP rather than JSON plus signed links:** private file links expire within a
minute, so a list of them would be useless by the time it is opened. Streaming keeps memory at one
file (the bucket's 50 MB limit) and starts the download at once. File bytes are capped at 400 MB per
download so the request stays within the 300-second function limit; files past the cap are listed in
`files.json` and stay in the account. **Not yet verified on Vercel:** that a streamed response larger
than the 4.5 MB buffered-response limit is delivered in full. Check this on a preview deployment with
an account that has files before relying on it.

The limit (3 a day) is enforced in the database by `admit_account_export`, so it holds across
function instances.

## Cleanup job

`GET /api/maintenance/account-cleanup` with `Authorization: Bearer <CRON_SECRET>` (the header Vercel
Cron sends). It is not scheduled yet. It:

- finishes deletions left pending for more than 15 minutes (the person already confirmed them);
- deletes Storage objects older than a day whose account no longer exists, or whose project row no
  longer exists (`orphaned_storage_objects`). Files of soft-deleted projects are kept, because those
  projects can still be restored.

Needs `CRON_SECRET` (at least 16 characters) in the environment.

## Tests

- `tests/database/account-deletion.test.ts` (PGlite, full migration history): a person with
  projects, history, paid and active runs, credits, a legacy job, a profile, an export request and
  Storage objects is fully purged while another person's rows are byte-for-byte unchanged; the
  accounting copy holds no id or content; history stays immutable outside the purge, including with
  the setting forged; API roles cannot call the server functions; orphan listing; export rate limit.
- `tests/server/account-deletion.test.ts`: step order, resuming after a failure at every step,
  prefix and stuck-Storage guards, email and freshness checks.
- `tests/api/account-deletion.test.ts`, `tests/server/account-export.test.ts`: routes (origin,
  captured account, no owner in the request), ZIP contents and filtering, size cap, cleanup secret.
