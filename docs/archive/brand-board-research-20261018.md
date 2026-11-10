> Archived November 10, 2026: describes the system before the generation engine.

> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](../architecture-review.md).

# Brand board research and app revision — 2026-10-18

## User requirements

Research accepted practice and apply improvements to the app's brand board. Prior requirements continue: show selected logo, palette, typography and applications; fit the desktop viewport; keep the inspiration attribution list, brand/audience summary, review banner and design-notes section removed. Preserve saved identity inputs.

## Sources and findings

- [Adobe: Create a brand style guide](https://www.adobe.com/creativecloud/business/teams/resources/how-to/brand-guide.html). Logo consistency, exact palette codes, primary/secondary roles, and font use cases/weights are core identity information. A comprehensive guide is broader than the compact visual board requested here.
- [IBM Design Language: Layout overview](https://www.ibm.com/design/language/layout/overview/). Essential content, hierarchy, alignment, scale, repeated relationships, negative space and asymmetric balance make a composition understandable. This supports prioritizing the logo rather than assigning equal emphasis to every tile. IBM's own brand-specific measurements are not transferred to Glide.
- [IBM Design Language: 8-bar logo](https://www.ibm.com/design/language/ibm-logos/8-bar/). Preserve the logo's artwork and proportions; ensure contrast and clear space. The app continues to show the exact selected image on white. No reversed logo, alternate lockup, numeric clear-space rule or minimum reproduction size is invented.
- [IBM Design Language: Type basics](https://www.ibm.com/design/language/typography/type-basics/). Type has functional roles and a hierarchy, including expressive headings and readable body text. The board demonstrates heading/body/label roles with the existing Geist family.
- [Style Tiles](https://styletil.es/). A concise visual language can be conveyed through fonts, colors and interface elements. This is useful context for the app's direction board; a style tile is not a complete production brand manual.

These are primary practitioner sources, not evidence of a universal brand-board standard. The exact column proportions, panel count and sample treatments below are design judgments under the user's constraints.

## Audit and changes

| Previous issue | Modification | Reason |
| --- | --- | --- |
| Six equal cards compete for attention | Unequal 5/3/4 foundation regions; 5/4/3 application regions | Establish a focal logo and reading order without a wide empty logo strip |
| Five tall equal color bars imply equal importance | Larger primary than accent, separate neutral list, visible HEX and role labels | Communicate functional color hierarchy compactly |
| Large Aa and slogans do not demonstrate body type | Heading specimen with actual weight, regular body pangram, medium label role | Make type information usable |
| Unapproved taglines presented as brand messaging | Use saved name/activity in application examples | Keep examples anchored to supplied content |
| Arbitrary ring/pill motifs and tilted stationery add an unsupported visual system | Remove decorative motifs and keep stationary logo application flat | Preserve selected artwork and avoid invented identity assets |
| Repetition and tiny metadata | Reduce repeated captions; keep essential labels at readable sizes | Protect the visible information budget |

Retained: one exact selected logo source used throughout, existing proposed color values, Geist font, three requested application examples, ownership checks, acknowledged saved inputs and no new paid generation. The current palette and type remain derived proposals; this revision does not record user approval or claim a production-ready logo package. Logo masters, alternate lockups, imagery and print color specifications are not supplied and are not fabricated.

## Verification

- Four direction/presentation tests: input dependence, contrast, selected logo type, exact-logo reuse, font roles and removal of invented slogans.
- Dedicated desktop/mobile browser checks: six panels, no horizontal overflow, desktop viewport fit, no clipped panels, mobile readability/scrolling, no reintroduced design notes.
- Typecheck and targeted lint.
- Visual review of the real account board with the saved Glide image and Dropbox/Cardless inspiration.
