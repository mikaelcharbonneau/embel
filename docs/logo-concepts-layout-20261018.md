# Logo concepts layout — 2026-10-18

## Approved reference

The user requested that Inspiration continue directly to Logo concepts and supplied
[Figma node 303:54691](https://www.figma.com/design/HP219GuYbpE8F1wHxj0h6N/Embel--Screens?node-id=303-54691)
as the layout reference. This is the current screen-specific approval.

## Implemented presentation

The existing account `/logo` route now opens a full-width concept gallery with a
three-column desktop grid, six result slots, a batch selector, compact filters,
and a floating composer. Mobile uses one column. Setup, reference inputs and
recovery controls stay mounted in the Project context dialog. The existing
refinement screen retains its controls and request flow.

Concept imagery remains dynamic and verified through the existing account client.
Empty slots do not render Figma's sample Forma logos as generated results. The
Selected filter uses the acknowledged existing concept selection. Concept likes
have no persistence contract and are visibly unavailable; no browser-only saved
state was introduced. Open chat links to the existing Strategy conversation.
The composer opens the existing cost review for changes to a selected concept;
it does not invent a general logo-chat integration.

Original Figma paperclip, chevron, heart and send icons are saved under
`public/logo-concepts/`. No temporary asset URL is used at runtime.

## Verification scope

Dedicated headless desktop/mobile browser fixtures exercise layout, batch history,
reload, cost review and request recovery. These are local fixture checks, not live
logo-provider validation. No paid generation or deployment is part of this change.

## Direct selection correction

The user removed the separate “Refine a direction” screen. Clicking or keyboard-activating a concept now uses the existing acknowledged account selection command in place. The selected card has a border and pressed state; Saving selection / Selection saved / actionable error follows actual persistence. The inspection layout is removed, and legacy `/logo/editor` links redirect to the concepts route. Dedicated headless desktop/mobile tests verify click, keyboard replacement and persisted selection after reload with zero quote/admission calls. No generated output is modified.

## Brand board continuation

The user requested Brand board as the next step after logo selection. The concepts screen now includes a right-aligned Continue to brand board link after the grid, enabled by an acknowledged saved selection. The owned project route `/brands/account/[projectId]/brand-board` reads that exact saved logo version through the existing verified preview path and displays saved brand name, activity and audience. It includes Back to logo concepts. This initial board does not invent a color palette or typography. Typecheck, targeted lint and desktop/mobile continuation checks passed; live navigation showed the owned Glide logo on the next page. No generation or publication was triggered.

## Brand board visual system

The user requested a palette, typography and brand applications based on their selected logo and inspiration. The board now reads acknowledged account inspiration choices and the exact selected raster source. A deterministic, explicitly suggested direction maps ensemble/color likes to original proposed color tokens; typography-only likes do not authorize color cues. Bold type references and logo category inform the type hierarchy. The bundled Geist Sans family and OFL license are used; custom logo lettering is preserved. Every recommended text/background pair is calculated with the WCAG sRGB formula and meets 4.5:1. Business card, social announcement and landing-page concept previews reuse the verified selected image, without changing its colors or geometry. No provider generation, font download or new write schema is introduced. The proposal recomputes from authoritative saved inputs on reload; it is not presented as user approval or a generated immutable deliverable. Four focused tests cover input dependence, contrast, logo-type response and all three exact-logo applications. Typecheck and targeted lint passed.

## Compact board correction

The user removed the visible inspiration attribution list and brand/activity/audience summary card from the board. Both are removed from presentation; saved inspiration continues to inform the derived system. The logo preview is reduced from 380px to 180px minimum height, section spacing from 64px to 32px, palette swatches from 180px to 120px, and application scenes from 360px to 280px. The redundant visual-direction headline is removed. Saved logo and inspiration data are unchanged.

## Scroll correction

The brand-board route fell through the project shell to Strategy, inheriting `.project-stage-strategy .project-workspace-content { overflow: hidden; }`. It now resolves to Identity while retaining its simplified navigation. Live verification measured an auto-scrolling content container (2267px content / 855px viewport) and a real downward scroll changed scrollTop from 0 to 988px, revealing typography and applications. Typecheck and targeted lint passed.

## Brand board composition redesign

The user requested more effective use of the board space. The selected logo now belongs inside the same twelve-column composition as the rest of the identity: logo beside palette, typography beside social application, business card beside website application. The previous isolated logo panel and long full-width sections are removed. Tiles share row heights, use compact captions and display colors with labels directly on the swatches. Numbered section headings and repeated prose are removed; provenance, usage, contrast and type specifications remain in collapsed Design notes & specifications. Existing logo/inspiration inputs and generation behavior are unchanged. Below 700px the tiles stack in reading order. Live visual verification used the saved Glide logo. Dedicated desktop/mobile browser tests verify row placement, no horizontal overflow, actual wheel scrolling, access to the website preview and expansion of notes. Four direction tests, typecheck and targeted lint passed.

## Board cleanup

The user removed the Strategy review status banner specifically from the brand board and removed Design notes & specifications. The shell now omits that banner on the board route, preserving the underlying saved Strategy state and other routes. The notes block and its unused styles are removed from the board, with tests updated to require its absence.

## Complete desktop board in one viewport

The user requested the complete brand board without scrolling. On desktop viewports at least 1001px wide and 650px tall, the board now fills the remaining workspace height with two equal rows of three panels: logo, palette and typography above social, business card and website applications. The compact heading and Back link share one row. Child panels adapt their previews and spacing to available height; no content is hidden merely to suppress scrolling. Smaller screens retain a readable flow. Dedicated desktop/mobile layout checks passed; desktop checks require all six panels within the viewport, no clipped panels, no overflow and no wheel scroll. Live 1434×988 verification measured workspace content height equal to viewport height (924px) and showed all six panels together. Typecheck and targeted lint passed.

## Research-based refinement

The user requested primary-source research and modifications following established practice. Findings, source links, audit and rationale are recorded in [brand board research](brand-board-research-20261018.md). The board now uses a logo-led hierarchy, compact primary/accent swatches with separately labeled neutrals, a heading/body/label type specimen, and application copy from saved name/activity. Unsupported ring/pill graphics, tilted stationery and invented taglines are removed. The full desktop board still fits without scroll; live workspace content and viewport both measure 924px. Four focused tests, dedicated desktop/mobile layout checks, typecheck and targeted lint passed. This changes presentation, not the selected logo, saved palette inputs, account state or generation runtime.

## Realistic brand applications

The user requested more realistic, professional applications using the selected logo, palette and typography. Dedicated presentation components now render a laptop/browser website, a phone/social-feed post, and layered business-card fronts/backs with paper edges, material lighting and cast shadows. The frame geometry is presentation-only; logo image bytes, aspect ratio, palette values and font family remain unchanged. No inverse or recolored logo is invented. Website/social copy uses the saved brief and application captions identify all scenes as previews. The printed card back uses the current primary and accent values; the front keeps the exact selected logo on white. Shared CSS variables update all scenes when the board inputs change. The full desktop board still fits one viewport. Four existing client checks passed; dedicated desktop/mobile tests check viewport fit, no horizontal overflow, and that all three device/print frames fit their scene bounds. Typecheck and targeted lint passed. Live visual QA used the account's saved Glide image. No new image/provider job or credential change was required.
