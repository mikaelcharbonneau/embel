# Production dependency audit

CI ("Web quality and production dependencies") runs `node scripts/ci/audit-production.mjs`, which
runs `npm audit --omit=dev` and fails on any advisory in a production dependency. npm cannot accept
a single advisory, so the script keeps a short `ACCEPTED` list. Each entry names one advisory, the
one package it may appear through, why it is accepted, and an expiry date after which CI fails again.

## Accepted advisories

| Advisory | Package | Expires | Why |
| --- | --- | --- | --- |
| [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) (ReDoS, high) | picomatch | 2026-12-31 | No fixed release exists (every version up to 4.0.7 is affected, checked November 18, 2026). It arrives only through the `workflow` package's tooling (`@workflow/cli` via tinyglobby, `@workflow/nuxt` via unplugin), and Embel never passes user-supplied glob patterns to it. |

## When a fix ships

Upgrade the package (or add an `overrides` entry in `package.json`), confirm
`node scripts/ci/audit-production.mjs` reports no vulnerabilities, and delete the entry here and in
the script. An entry that expires without a fix needs a fresh review before its date is extended.
