# Live development checks

These tests are prepared but have not been run against a provider. `npm test` runs only the local gate tests. `npm run test:live` skips every service check unless `FLUID_RUN_LIVE_TESTS=1`; explicit opt-in with incomplete setup fails closed before creating a client. The checked-in target is the verified approved Free North Virginia project `fricsfwqibyhemknqgyf`. This allowlist entry does not enable the suite. See [hosted database evidence](../../docs/supabase-integration.md); real Auth/Storage session fixtures remain pending.

This suite reads two dedicated users' existing fixtures through real Auth, PostgREST and private Storage. It verifies both directions of tenant isolation, immutable download hashes, and denied cross-user signed URLs/public downloads. It does not create users, refresh sessions, apply migrations, write rows, upload files, execute jobs or call a model. A rollback-only hosted SQL probe has verified database mutation/lease boundaries. Actual authenticated HTTP mutations and concurrent worker execution remain unverified.

Before activation:

1. Reconfirm the approved development target in `approved-target.ts`; never point this suite at a previous Fluid project or production. Project creation, migration application and rollback-only SQL isolation verification are complete.
2. Apply reviewed migrations and prepare two dedicated test accounts only after that setup and credential access are authorized. For each account, create a test project, an asset and immutable asset version, and a small private `fluid-assets` object (1–16384 bytes). The version's `provenance.fixture` must equal `fluid-live-isolation-v1`, its `content_hash` must be the object's SHA-256, and its path must be `owner/project/asset/version`. Fixture provisioning is not automated by this suite.
3. Inject a publishable key and short-lived access tokens into the test process using secure session/secret tooling. No service-role key, database password, refresh token or user password is accepted. Never put credentials in chat, shell history, source, snapshots or test reports.
4. Provide these process environment names: `FLUID_RUN_LIVE_TESTS`, `FLUID_LIVE_PROJECT_REF`, `FLUID_LIVE_PUBLISHABLE_KEY`, plus `FLUID_LIVE_USER_A_ACCESS_TOKEN`, `FLUID_LIVE_USER_A_PROJECT_ID`, `FLUID_LIVE_USER_A_ASSET_VERSION_ID`, and the three corresponding `USER_B` names. The suite never reads an env file automatically.
5. Run `npm run test:live` with the explicit opt-in set to `1`. Expired tokens fail verification; the suite never signs in or silently substitutes a fixture identity. Keep result reporting limited to check counts and sanitized errors.

Official references checked 2026-10-02: [getUser validation](https://supabase.com/docs/reference/javascript/auth-getuser), [private Storage access](https://supabase.com/docs/guides/storage/buckets/fundamentals), [signed downloads](https://supabase.com/docs/guides/storage/serving/downloads).
