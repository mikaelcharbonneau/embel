> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](../../architecture-review.md).

Fluid Logo and Visual Identity Specification

Version 1 for written review

5 October 2026

Purpose and approval boundary

This specification defines Fluid's logo-first creation workflow for founders and other users building a brand. Visual Identity and logo production are the product priority. The immediate goal is complete, reliable functionality; aesthetic benchmarking, prompt tuning and output-quality optimization come later.

The functional design has been approved in conversation. This written specification is the next review point before the implementation plan. Approval of the specification does not authorize provider purchases, paid generation trials, new credentials, expanded access or public deployment. Those actions retain their own approval requirements.

The user journey

Start with a brief

A user may start directly with a short logo brief without completing the full Strategy workflow. Capture the brand name, what the business does, its audience and desired personality. Reuse existing project Strategy information when available. The source brief and its version remain attached to the work so later changes are visible rather than silently rewriting earlier results.

Users choose one or more supported logo types themselves: wordmarks, lettermarks or monograms, pictorial marks, abstract marks, combination marks, emblems and mascots. All seven are in scope.

Establish visual references

Users choose examples from a curated reference library and may upload their own. Both sources offer the same controls for expressing what they like: lettering, shape, composition and overall feel. References guide an original result; they are not instructions to reproduce another logo.

Record each selected reference and the aspects selected. Uploads and derived assets belong to the signed-in user and must pass file and access validation. Third-party references need traceable sources and an appropriate right to display or process them. Reference licensing and the source of the curated collection must be verified before live use.

Explore six logo concepts

The first batch contains six genuinely different logo concepts in black and white. These are six total concepts, not six per selected type. Each concept identifies its logo type. If more than six types are selected, the interface must not imply that every type is represented in that first batch; coverage must remain explicit.

Image previews are acceptable at this stage. Do not label them editable vectors. Show successful concepts as they finish and retain them even if another concept fails. A user can retry failed concepts without regenerating successful ones. Retry costs must be disclosed before proceeding.

Provide separate actions to generate more concepts and to refine a selected concept. Before every AI generation or revision, show the estimated credits or cost and require an explicit user click. Manual editing does not itself dispatch an AI request or create an AI charge. The application must distinguish an estimate from a confirmed charge and avoid claiming failed provider requests are always free.

Select and convert to vector

The user chooses a concept for production. Convert it to genuine vector artwork before detailed editing and final delivery. Preserve the original preview alongside the vector revision.

When conversion noticeably changes the result, show the difference and let the user retry, simplify or refine it. Do not silently approve an inaccurate conversion. An SVG or PDF containing only an embedded raster image is not a vector logo.

The vector representation must support the selected logo type, including illustrated mascots and emblems. The implementation must validate paths, fills, strokes, dimensions and any remaining text or font dependencies. Complex artwork may require a different conversion method than a simple symbol. Provider and library selection belongs in the implementation plan, supported by verified capabilities rather than assumed vector output.

Refine with AI and direct controls

Support both natural-language revision requests and direct controls for text or font, spacing, size, rotation, color and symbol/wordmark arrangement. An anchor-point or individual path editor is not included at launch.

Users can lock components they want to keep. Revision requests must carry those locks, and a returned change must not silently replace locked content. Preserve prior versions and allow explicit restoration. A restored version becomes a new current selection; historical records remain intact.

Font controls apply to actual editable text. Outlined custom lettering must not be presented as editable font text. Replacing outlined lettering with a font-based wordmark is an explicit change shown to the user. Preserve the approved brand-name spelling, and make unsupported edits honest rather than simulating them.

Build the broader identity

After the user approves the logo, propose three coordinated directions for colors, typography and supporting graphics built around that logo. These are downstream identity directions, not three full identities generated before logo selection.

Users may combine components from different directions, such as one palette with another type system. Check the combined result for consistency and legibility. The selected logo remains protected unless the user explicitly requests a logo revision. Changes that make downstream work stale must be shown before exports are refreshed.

Use fonts licensed for free commercial use, plus user-uploaded fonts they have the right to use. Paid-font suggestions are excluded at launch. Verify actual embedding, modification and redistribution permissions separately; free use does not automatically permit every kind of font-file redistribution.

Provide RGB and HEX values. CMYK values must identify the relevant conversion/profile limitations. Pantone suggestions are approximate references only when a valid, lawfully usable matching source exists; otherwise show them as unavailable instead of inventing a match or guaranteeing print equivalence.

Deliver usable brand files

The default logo pack includes the primary logo, horizontal and stacked arrangements where appropriate, a symbol-only version when a symbol exists, and black, white and color versions. Check each arrangement visually rather than mechanically rearranging every design.

Required logo formats are SVG, genuine vector PDF and transparent PNG. Files must open correctly and represent the approved version. A simple brand guidelines PDF is included by default, covering logo use, color specifications, typography and spacing rules. Social avatar and banner exports are optional selections, not mandatory outputs.

Downloads must be real, verified files tied to the selected brand and version. The Assets library should retain ownership, source/provenance, version relationships and permitted use. Do not include unavailable or unlicensed font files in an export package. Export packaging must not turn an unverified draft into an approved identity.

Saved stages and application boundaries

Use separate saved stages for the brief and references, concept exploration, chosen vector logo, refinements, identity directions and final deliverables. This allows users to resume and retry without regenerating the whole project.

New logo-first records need their own versioned contract. Preserve legacy three-board records without reinterpreting them as six-logo explorations. Each saved revision records its owner, project, parent revision and relevant input versions. Server-side checks determine ownership; client-supplied owner fields are never trusted.

Separate the user interface, orchestration, provider adapters, vector conversion, asset storage and export generation. Each boundary returns explicit capability and error states. The existing text-subscription connection and the image-generation provider remain distinct. Do not silently replace an unavailable configured provider or model with another paid route.

Generation requests need durable request identities, per-concept outcomes and idempotent application of results. A repeated click or interrupted connection must not silently dispatch duplicate paid work. An uncertain provider outcome stays pending reconciliation rather than being assumed failed and retried. Preserve partial successes and the last valid saved state.

Keep credentials server-side and outside exported project files. Live storage and generation require reviewed least-privilege access. Do not reuse administrator credentials or unrelated worker credentials to work around missing Identity permissions.

Rights and warnings

The intended offering is commercial use with an exclusivity objective. Export alone does not establish exclusive legal rights, copyright protection, uniqueness or trademark clearance. The actual offering must be supported by provider terms, source assets, font licenses and an appropriate user contract before it is promised.

Similarity to famous marks should produce a warning rather than an automatic application-level block. Clearly distinguish similarity screening from legal clearance. Sensitive-category handling should use warnings and review where permitted; mandatory provider restrictions and applicable safety rules still apply.

Functional acceptance before quality tuning

A user can start from Strategy or a standalone brief and select any supported logo type.

Curated and uploaded references retain the same selected aspect controls.

A six-concept request shows explicit per-concept progress, partial success and failed-only retry.

Costs are shown before AI actions; repeated clicks and network recovery do not create unintended duplicate dispatches.

Image previews are never mislabeled as vectors; selected vector output contains real editable geometry.

The user can compare conversion changes and retain the original concept while retrying or refining.

Focused editing, component locks, revision history and explicit restore work without silently discarding prior work.

Three post-logo identity directions can be selected and mixed, with stale downstream results identified.

Free-font and uploaded-font permissions are tracked; unsupported Pantone or print matches remain explicitly unavailable.

Logo variants, SVG, vector PDF, transparent PNG, guidelines PDF and selected social exports match the approved version and open correctly.

Saved work survives reload; different accounts cannot read or modify each other's drafts, references or assets.

Desktop and mobile controls, keyboard access, interrupted work, error recovery and verified downloads pass their relevant checks.

These gates test correctness and usability. Aesthetic ranking, new reference benchmarks and extensive prompt/output tuning are a later phase and do not block the initial functional build.

Implementation prerequisites

The implementation plan must resolve the incomplete trusted Identity save/helper contract, establish production asset storage and export access, and select a genuine vector-production path. Live image credentials, provider availability, spending limits and hosted permission changes require their applicable approval before activation.

Local tests and synthetic adapters may validate the workflow without paid calls. They must not be reported as proof of live provider, hosted concurrency or final production output quality. Completion claims must identify which acceptance checks were actually run.

Review requested

Review this written specification for alignment with the agreed workflow. After approval, prepare the implementation plan with isolated work ownership, concrete tests, staged integration and the exact external activation approvals required. Creative implementation should follow that reviewed plan.
