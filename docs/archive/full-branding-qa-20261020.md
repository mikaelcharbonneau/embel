> Archived November 10, 2026: describes the system before the generation engine.

> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](../architecture-review.md).

**Result: partial pass.** The new full-flow QA project persisted strategy, a selected name, inspiration, six logo concepts, one refinement, the selected logo, a board preview, and seven PNG assets. One PNG download completed. The approved identity and complete export package remain blocked by the product’s approval path.

Project: [QA — Full branding flow — Saint-Roch — 2026-10-20](https://www.embel.xyz/brands/account/77936053-5911-441b-a7b0-0a9bc8a4c045)  
[Final saved board](https://www.embel.xyz/brands/account/77936053-5911-441b-a7b0-0a9bc8a4c045/brand-board)

Tested on October 20, 2026, through the existing signed-in Mac Chrome account using normal UI controls.

| Stage | Verified outcome |
|---|---|
| Brief | The synthetic bilingual Saint-Roch neighborhood café brief persisted. |
| Competitors | Initially queued with a delivery failure. Following separately authorized recovery of the same request, execution started and saved three sourced options: Nektar, Café Saint-Henri, and Maelstrøm. Results survived reload. |
| Audience | Neighborhood regulars and nearby workers selected and saved. |
| Personality | Neighborhood host selected; strategy completed and saved. |
| Naming | **Final count: 100 names from one exploration.** Started 03:57:41 UTC; completion observed around 04:04:33. Bel Élan was saved and selected, then confirmed after reload in project v7. |
| Inspiration | Saved INBO poster colors/layout and Mastercard brochure typography. |
| Visual direction | Four guidance fields reviewed and saved as version 1; persisted on return. |
| Logo generation | One six-concept batch confirmed at 04:09:27 UTC. Estimated and maximum costs displayed were both $12.00; actual charge was not verified. All six progressed to Ready with actual images and survived reload. |
| Selection | Concept 1, the Bel Élan wordmark, selected and saved. |
| Refinement | One targeted refinement completed as Concept 1 Version 2. The selected revision persisted after subsequent navigation. |
| Board | Displayed the selected refined artwork and application previews. |
| Assets | Seven PNG records loaded for this project. |
| Download | One Check and download action completed. Chrome reported Done, and the local PNG opened successfully. Preserved as `bel-elan-qa-logo.png`, 282,691 bytes. |
| Complete package | No identity approval or final export package completed. |

**Generation and refinement quality findings**

- Concept 3 contained a coffee-bean/leaf motif. The saved visual-direction guidance excluded beans, but that page explicitly says its guidance applies to identity directions after logo approval. Therefore, this demonstrates a mismatch with saved creative intent; it does **not** prove that the logo provider received and ignored that exclusion.
- The selected wordmark avoided the coffee-bean symbol.
- The refinement prompt explicitly prohibited a leaf, along with cups, beans, icons, taglines, badges, and extra text. Its custom É accent nevertheless appears leaf-shaped. This is the clearer prompt-adherence failure.
- The refinement began directly after submitting the change prompt; no separate cost-review dialog appeared.
- Website and social previews repeated the entire raw QA brief as customer-facing copy, including “Fictional QA test” and creative instructions.
- The board’s palette and typography were defaults, not demonstrated outputs of completed identity generation.

**Naming and interaction findings**

- Naming initially defaulted to `en` despite the bilingual brief. I changed the project’s normal creative-language preference to `fr-CA`.
- The selected name populated `belélan.com`, while the domain field’s help text excludes IDNs. No domain lookup or purchase was performed.
- Inspiration controls disable temporarily during saving. A second click during that interval can be ignored; the intended final selections were verified.

**Asset metadata mismatches**

- All seven records were named `logo_concept`, making the originals and refinement difficult to distinguish.
- Every record showed “Not selected,” including the artwork selected in the logo workspace and displayed on the board.
- Each asset showed one version, while the concepts workspace represented the refinement as Concept 1 Version 2.
- The inspected asset reported “Legacy record · provider unverified,” “Context unverified,” and unverified license/vector origin despite being generated during this test.
- Assets displayed “Image generation is not connected” while successfully listing the seven newly generated PNGs.
- A browser-control timeout occurred during download observation. I did not repeat the download. Its outcome was subsequently resolved as successful using Chrome’s Done status and the verified local file.

**Exact complete-package blockers**

1. `/logo/directions` requires approval in the logo editor. `/logo/editor` redirects to `/logo`, which exposes selection and refinement but no approval control.
2. `/logo/deliverables` says **“Approve a logo and identity direction first.”** Both **Prepare variants** and **Create brand files** remain disabled.
3. Project font controls are disabled with a message that connected owned storage is required to add catalog fonts or upload files.

These are product prerequisite blockers, not pending approval requests or uncertain submissions. No settings or storage configuration was changed.

**Checks after deployed reload**

After you confirmed release `f30da00b4203189ec6f382e4d3d8e459d5fd2b3e` was live, I reloaded the saved board and verified:

- **“Selected logo”**
- **“Bel Élan · Saved selection”**
- **“Proposed palette”**
- **“Neutral starting point”**
- **“Proposed typography”**
- **“Geist Sans · Default preview”**
- **“Application preview”** on website, social, and business-card sections

The refined artwork persisted. The board exposes no approval, editing, download, or export action; its project navigation returns to logo concepts. Brand files were revisited on the deployed release and remained blocked.

Account disclosure checks:

- Enter and Space both open it.
- Tab order: Check account → Sign out → Account connected → Activity.
- Sign out was focused only, never activated.
- Escape closes the disclosure and restores focus to Account menu.
- Enter opens Activity and focuses Close activity.
- Escape closes Activity and restores focus to Activity.
- Clicking outside the disclosure leaves it open. This is an observed behavior, not a claimed failure of a specified requirement.

Assets refresh retained all seven loaded records and the project filter. Multi-page preservation was not exercised because this fixture contains only seven records.

**Correlation and evidence**

The new competitor request ID supplied by you was `bb30819f-83b3-40dd-9dbc-0e152232db82`; recovery was accepted once at 03:50:55 UTC. No request identifier was visible in the logo UI.

The earlier competitor-only project remains separate and untouched:
https://www.embel.xyz/brands/account/ae564ab0-cc95-459d-8e8e-c82807c1f6c9

Its parent-supplied request was `d73ae3bb-dfb3-4a4f-a1fa-4a7bd5a5ef12`; that test persisted a location clarification.

Screenshots retained include competitor options, saved strategy, selected name, logo execution, all six logos, the refinement, seven assets, successful download, blocked exports, account disclosure, and `embel-full-flow-final-board.jpg`.

The QA project and outputs remain intact. No further UI actions or paid generation were performed for this reporting step.
