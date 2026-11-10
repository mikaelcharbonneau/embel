# Exact source evidence for historical research adjudication

These passive text fixtures preserve `src/server/ai/strategy-response.ts` from
this application's own private repository. They are never imported or executed
as application code. The SQL adjudication tests continue to require the exact
SHA-256 and completed-status branch ordering recorded for each incident, and
can now run offline in a source archive without Git object metadata.

Retrieved read-only on 2026-10-15 using the existing authenticated GitHub CLI
and the GitHub Contents API with an exact commit reference. The repository
documented in `docs/archive/cloud-development.md` as `mikaelcharbonneau/emble` redirects
to `mikaelcharbonneau/embel`: repository ID **1410624483**, private, created
2026-10-08T16:08:49Z, default branch `main`. Both commit objects and source bytes
were read from that same repository. No checkout, Git history, remote source,
credentials, or deployment was modified.

| Commit | Source path | SHA-256 |
| --- | --- | --- |
| `af6faf18912cc24afb37179a6988a11f83cf9cdf` | `src/server/ai/strategy-response.ts` | `419acb2adcdb5bf27ee99f92bf3f737876efad9ca8c4a7c1836f1c00a68a1255` |
| `4c0bbf362e8c85132f9d5068ec25dc771ef5cd5b` | `src/server/ai/strategy-response.ts` | `d37e4c528334e7099d042d835d2cebc75cc06d214c2b52deb3299e38441888a9` |

The fetched bytes matched the pre-existing expected hashes before these files
were added. Do not rewrite the snapshots to match current behavior or replace
their expected hashes with values calculated from a working tree.
