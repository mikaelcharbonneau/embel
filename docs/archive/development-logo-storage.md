> Archived November 10, 2026: describes the system before the generation engine.

# Local Logo Storage issuer

The reviewed `supabase/candidates/logo_worker_storage.sql` accepts only the hosted Auth issuer. The separate `supabase/development/logo-storage-local-issuer.sql` changes that one issuer predicate to exactly `http://127.0.0.1:54321/auth/v1` for an isolated local development database. The hosted candidate is unchanged.

This is a source-only local setup packet, not a migration, activation or permission to connect a development worker to production. It creates no account, login, credential, binding, grant, policy or Storage object. It does not enable any operation or establish live Storage readiness.

Before a separately reviewed local installation, the operator must verify the Docker `embel-local-dev` instance and its loopback database mapping at port 54322. Only after verifying that target may the operator explicitly set the database-level non-secret marker:

```sql
ALTER DATABASE postgres SET embel.development_target = 'embel-local-dev';
```

The marker is a deliberate operator assertion; it cannot prove physical location by itself. Never mark a hosted database to satisfy the guard. The patch reads the database-wide catalog setting with `setrole=0`, so session values and role-specific settings cannot substitute for that assertion. It also requires database `postgres` and the exact reviewed predecessor function body, owner, language, volatility, security-definer status, search path, and private ACL.

The patch preserves the function OID, ownership, ACL, other metadata, and every other Auth/session/owner/worker predicate. It exposes no configurable issuer or client-supplied target. Hosted, `localhost`, shortened loopback, alternate-port, HTTPS and trailing-slash issuers remain rejected. Expiry, sign-out/session deletion, explicit timeboxing, anonymous users, disabled bindings, mismatched role OIDs and role memberships remain fenced.

The packet must be applied once after the original reviewed Storage candidate. Reapplying it or applying it to a changed predecessor fails closed. The related generative/production Storage candidates, their reviewed ordering, actual provider service support, restricted worker principal and separate Storage Auth identity still require independent setup. This issuer patch supplies none of them.

The regression suite executes the SQL only in disposable PGlite databases, with synthetic provider claim/session interfaces. It verifies installer guards, immutable production source, unchanged ACLs/policies/default privileges and the actual SQL session boundaries; it does not verify JWT signatures or a running Auth/Storage provider.
