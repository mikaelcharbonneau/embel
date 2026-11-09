> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# Namelix reference assessment for Embel Naming

Date: 2026-10-16. Scope: read-only assessment of the user-supplied archive, with selected inert reference copies retained under ignored `.references/namelix-review-20261016/`.

## Recommendation

Use the archive as a behavioral reference, a source of concrete interface and request-state examples, and a recorded comparison case for the Naming pilot. It can reduce uncertainty in implementation and testing. It does not recover Namelix's creative backend or validate Embel's proposed five-role architecture, and it is not an application component to import.

Keep Embel's agreed Strategy inputs, approach choices, curated exploration, account persistence, unique-name count, and continuous grid. Build original code against Embel's contracts. Do not use Namelix's endpoints, renderer, fonts, assets, or shipped application code as production dependencies.

## Evidence inspected

- Archive: `/Users/mikael/Downloads/namelix.zip`.
- Archive SHA-256: `c4a9e261d1f117b0c1d5cf36ad45412c9a5b41666d00936fa3682815e2d8227b`.
- Inventory: 53 files, 21,131,245 uncompressed bytes. All 49 entries listed in its checksum manifest matched their archived bytes; no manifest mismatches or unresolved manifest paths. This establishes internal consistency, not independent authentication of Namelix's deployment.
- Read both investigation reports, inspected relevant client source as text, parsed generation/category/variant payloads and the eight-entry selected HAR, inspected the retained REA summaries, and viewed style/category screenshots.
- No archived scripts were executed, no recorded endpoint was called, and no browser session was replayed.
- Retained REA records: static `ev_1021ff83cc49f1224cd27ace849efa705c7469e64b6aa8eb470e3756c1d3922c`; network `ev_7b078e9b46b726efaa62cb066a0c3fd28e0512b3385f0fe8268f1730fba1fe72`. These IDs identify the supplied investigation, not a new REA run performed during this review.

The selected HAR is a derived, eight-transaction recording with headers/cookies omitted. The reports explicitly state that static and runtime acquisitions were not reconciled byte for byte, normal scroll pagination was not exercised through multiple ordinary batches, and alternate experiment variants were not investigated. Static source and the supplied recordings should retain these separate scopes.

## Directly corroborated findings and their use

| Finding in the supplied snapshot | Evidence | Use for Embel |
| --- | --- | --- |
| Style cards show explanations/examples, including Real words with Apple and Amazon. | `screenshots/style-wizard.jpg`; source appendix's style-value mapping. | Use examples to make the already agreed approach widgets understandable. Keep Embel's multi-selection and separate directness choice. |
| The client starts loading near the bottom, guarded against concurrent loading, configuration, and saved views. Its threshold is about two viewport heights, with a 100 ms debounce. | `evidence/client-source/app.html:1911–1922` and `2331–2338`, read as text. | A concrete reference for early refill and mode guards. Derive Embel tests from it; tune our threshold to measured latency rather than copying a fixed threshold unquestioningly. |
| Ordinary generation sends the brief, style, prior names/references, saved names, category, page, and seed. | HAR record 1; source `app.html:2362–2380`. | Supports explicit context handoff, history, and preference inputs. It does not prove what the server does with them. |
| A saved name is included in a subsequent category request. | HAR record 7 includes `saved: ["Pura Beans"]` and category `Bamboo Varieties`. | A concrete behavior case for carrying likes into later work. No evidence of model training or a particular preference-learning algorithm. |
| Similar-name exploration is a distinct request using the original name and `style: "variant"`. | HAR record 2; `variants-response.json`. | A useful reference for stronger More like these steering. Its internal sampling and ranking remain unknown. |
| Brief-specific categories are generated separately and can steer another generation request. | HAR records 0 and 7; `categories-response.json`; category screenshot. | Useful examples for the Director's conceptual territories, without adding new fixed naming techniques. Exposing these territories as user controls would be a separate product proposal. |
| The initial response contains 30 design records but only 28 distinct business names; the variant response contains 24 records and 22 distinct names. | Parsed `businessName` values in `generation-response.json` and `variants-response.json`. | Embel's 100-name target must count distinct names, independently of any future visual treatments. These captures are not evidence for a 30-name or 24-name universal batch size. |
| Client append methods push records without enforcing name uniqueness. | Source `app.html:2645–2658`; the earlier duplicate-aggregation block is commented out. | Preserve Embel's independent validation and complete database-backed duplicate index. Server-side Namelix deduplication is unknown. |
| A detail explanation contains an etymological claim without source references in that response. | `feedback-response.json`. | Demonstrates the need for our claim-level verification. This review does not establish whether that particular etymology is correct. |

## Particularly useful creative reference

The recorded coffee brief produced categories including Bamboo Varieties, Sunrise & Sunset Terms, Nordic Folklore Creatures, Hausa Proverbs, Mid Century Modern Furniture, and Sacred Geometry. Their presence is observed; their quality, appropriateness, and any underlying linguistic/cultural research are not established by the recording.

This illustrates a distinction already useful in our design:

- An **approach** describes how names are developed: Real words, Compounds, Invented words, and the other selected routes.
- A **territory** supplies a particular world to explore for this brief: an animal family, a ritual, an object collection, a cultural reference, or another association.

The Director can commission several different territories within an approach. A Real words assignment should therefore reach beyond immediate category synonyms. The selected directness and Strategy still guide the exploration, with room for loose connections.

## Patterns to assess independently

- The shipped progress animation generates percentage changes and stage labels locally. It does not establish actual backend stages. Embel's feedback should reflect real work or remain honestly indeterminate.
- The ordinary generation client includes repeated error/empty-response retries. This is not evidence of safe idempotency; it should not replace Embel's paid-request reconciliation rules.
- The observed saved-state mechanism uses localStorage. It does not establish account synchronization and does not change Embel's database-authoritative account design.
- Domain booleans and trademark classifications in the archive were not independently verified. They do not establish availability, provider authority, or clearance and are outside this Naming-brain assessment.
- Label-to-value mappings are not necessarily semantic definitions: the shipped Evocative card uses `twowords`, for example. Embel should retain its own explicit technique contracts rather than deriving them from competitor field names.

## Proposed use in the Naming pilot

1. Use the captured sustainable-coffee brief as one comparison case. Keep Namelix's actual candidate outputs out of Embel's Creator prompts so the comparison does not encourage imitation or leak the reference answers.
2. Compare equal-sized samples of distinct names, with the brief and naming choices disclosed. The captured default/medium configuration is not equivalent to every Embel preference combination, and one brief cannot establish overall superiority.
3. Test initial delivery, advance refill, saved feedback, stronger steering, stale-response handling, and duplicate prevention using original, clearly synthetic Embel fixtures.
4. Inspect whether independent assignments produce materially different territories and constructions, including unexpected Real words, while retaining traceable explanations and evidence for factual claims.
5. Measure Embel's own latency, cost, and verification success. Those properties are not recoverable from Namelix's client or this limited capture.

## Related local references

- [Embel Naming brain design](superpowers/specs/2026-10-16-naming-brain-design.md).
- [Supplied investigation report](../.references/namelix-review-20261016/namelix-reverse-engineering.md).
- [Supplied static-source appendix](../.references/namelix-review-20261016/client-static-findings.md).
- [Captured style wizard](../.references/namelix-review-20261016/screenshots/style-wizard.jpg).
- [Captured category exploration](../.references/namelix-review-20261016/screenshots/category.jpg).
