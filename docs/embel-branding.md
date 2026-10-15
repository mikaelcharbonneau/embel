# Embel branding

The user renamed the product from **Fluid** to **Embel** on 2026-10-13 and explicitly confirmed that spelling. Use Embel for the app, account and settings copy, accessibility labels, page titles, assistant identity, new downloads and generated PDF creator/producer metadata. The private npm package is `embel-platform`.

The approved symbol is unchanged. `/embel-mark.svg` contains the exact original approved SVG bytes; `/fluid-mark.svg` remains available for existing links. Neither this rename nor the app title introduces a new design reference.

## Compatibility

Existing user data and service connections must continue to work. Keep `FLUID_*` environment variables, `.local-fluid`, localStorage keys, event names, attachment headers, schema literals, SQL roles/schemas, bucket names, queue names, worker policy identities, OAuth registrations and Vercel project slugs unchanged. Existing Names JSON backups still import regardless of their filenames; new backups use `embel-` filenames and the same data format. Previously saved projects, messages, generated outputs and immutable exports are not rewritten.

New PDF metadata says Embel. Geometry, renderer versions, preview hashes and validation policies remain unchanged; publication still verifies and records the actual file bytes and their hashes. Existing output records retain their original bytes and receipts.

Historical decisions, test brand specimens, Figma's original **Fluid — Screens** file name, Wonder URLs, receipts and hashes describe their original evidence. They retain those names. Current product guidance follows this rename.

## External setup

The existing protected Vercel URL and project identifiers remain in use. Moving to a custom domain or renaming a deployed service is a separate configuration change because callbacks, OIDC claims and worker trust depend on those identities.

The intended signup email sender is **Embel <noreply@embel.xyz>**. Configure the sender name as `Embel` in Supabase's custom SMTP settings after Resend verifies the domain. Application source changes do not update dashboard-managed email templates or sender settings; their configuration and real delivery remain separately verifiable.

## Verification

Global typecheck and lint, the web production build and the API text worker bundle passed. The selected regression set passes 563 tests across 35 files. Rendering fixtures were rerun with lower concurrency after resource-related timeouts; the credential permissions fixture now explicitly sets its intentionally insecure directory mode so it also works under a restrictive process umask.

Browser verification covers 22 page/branding checks at 1440 px and 390 px, plus 28 selected desktop/mobile interaction checks for signup, overlays, Names backups, Domains/Trademarks downloads, Handles, Settings and existing browser drafts. The draft fixture preserves the original `fluid.local-drafts.v1` key and a user-authored project named `Fluid studio`, then verifies saved follow-up messages after reopening. Obsolete Home-control and trademark-heading expectations were updated to the current screens. The auth callback check uses the supported local runtime origin on port 3106; production origin validation remains strict.

Non-secret manifests, screenshots, initial failures and reconciled rerun logs are retained outside the checkout at `/workspace/scratch/embel-branding-20261013/`. No provider call or real signup/email is included in these fixture checks.
