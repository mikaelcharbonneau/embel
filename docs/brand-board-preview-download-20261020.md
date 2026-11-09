> **Archived November 9, 2026.** Historical record; it may not match the current code. Current architecture and plan: [architecture-review.md](architecture-review.md).

# Brand-board PNG preview — source implementation, 2026-10-20

## Scope and honest output

[Issue #58](https://github.com/mikaelcharbonneau/embel/issues/58) adds a bounded
local take-away to the compact saved brand board. The new action prepares an
opaque 1600 × 1100 PNG **board summary/preview** containing the selected raster
logo, the displayed deterministic proposed palette and default Geist typography.
It is explicitly not an approved identity, SVG/PDF master, transparent logo file
or final brand package. Application mockups are not included; the artifact says
so. The existing production deliverables workflow is unchanged.

The existing six board tiles, their proposal/placeholder labels and precise
stale-selection guidance are retained. A separate action row is added before the
board. No raw activity, audience, personality or other brief instructions enter
the export snapshot. No taglines, claims, production guidelines or new brand
approval are generated or inferred.

## Read and lifetime boundaries

- The exact selected immutable receipt goes through the existing private account
  client, which validates owner/project, publication, hash, MIME and byte length.
  Preparation makes one additional read of that source. It then reads only the
  resulting local blob URL, checks its raster signature and decodes the image.
- The presentation snapshot detaches the displayed name, palette, default font
  values and stale-selection label from input objects. Changes to those values
  or receipt identity remount the download lifetime; late results cannot combine
  old artwork with new metadata.
- The renderer draws a dedicated layout using native canvas primitives, never a
  DOM screenshot or a third-party renderer. It preserves the logo's aspect ratio
  and adds no recoloring, transparent background or invented lockup.
- The real local Next/font Geist family must load at the used weights. Missing
  font, decode or canvas support fails visibly rather than silently substituting
  another font. The resulting PNG is signature-checked and decoded at its claimed
  dimensions before the download button becomes enabled.
- Clicking the enabled button performs another fresh owner-checked read and
  decode of the same receipt. Revoked/missing/expired access cannot be bypassed
  with the prepared blob. Account/client validity is checked immediately before
  creating the download URL. Duplicate clicks share one pending action.
- Preparation and download revalidation each have a 20-second bound, including
  image/font/encoding waits. Cancellation releases the verified image URL;
  delayed results are ignored and late preview URLs are released. The output
  download URL is released after one second or immediately on unmount/change.
- Errors offer a read-only retry or reload/sign-in guidance. The UI reports only
  that a browser download was started, not that a file has been saved to disk.

No new dependency, API, database/storage write, permission, provider call,
credential, public upload, approval or saved export manifest is introduced.
There is no new production entitlement or vector/export worker activation.

## Verification boundary

Focused tests use synthetic saved receipts/private bytes and instrumented browser
primitives. They assert the native canvas draw instructions, exact source reads,
proposal/type labels, opaque PNG MIME/dimensions and local decoding; they do not
claim an actual browser visual acceptance run. Existing board tests retain
read-only reload, ownership, missing-source and placeholder-copy coverage.

Full typecheck/build, live account behavior and desktop/mobile layout validation
remain integration checks. No deployment, runtime/database mutation, live browser
or provider validation was performed for this increment.

Final focused run: **50 tests passed in four suites** (`brand-board-preview-export`,
`brand-board-preview-download`, `brand-board-page`, `brand-board-direction`).
Targeted ESLint passed for the new source/tests and changed page/test. The source
and test files also passed isolated TypeScript transpilation, which is not a full
semantic typecheck or production build.
