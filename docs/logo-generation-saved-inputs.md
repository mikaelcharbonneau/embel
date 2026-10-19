# Logo concepts from saved brand and inspiration

## User-approved objective

On 2026-10-18 the user requested working generation of six concepts from the
current saved brand and Inspiration choices. Preserve the current concepts
layout and existing saved work. This request is not a public deployment or
permission to purchase provider credits.

## Implemented input boundary

`GET /api/projects/:id/logo/saved-inputs` authenticates the account and reads its
current project and acknowledged Inspiration choices through existing RLS APIs.
It rejects owner/project mismatches, a changed project revision, a naming-only
project, or input that exceeds the existing brief bounds. The response is private
and non-cacheable. It neither saves a logo brief nor admits a generation job.

The source is the saved selected name (or saved supplied name), activity,
audience, personality and identity notes. A missing saved name yields a null
draft. Differing selected/supplied names are explicitly flagged. Project titles
are never substituted for brand names.

Chosen curated references become compact textual guidance in the saved brief:
catalog version, selection revision, source slug/brand/creator, selected aspects
and catalog tags. No public reference image is relabeled as an owned upload,
licensing permission or generated result. Initial concepts keep the existing
black-and-white constraint; color choices can guide subsequent identity work.

The default six type slots cover wordmark, lettermark/monogram, pictorial,
abstract, combination and emblem. The existing quote/admission pipeline freezes
the acknowledged brief and hashes it into the immutable concept inputs. Each
slot retains its existing durable job, provider response, accounting and asset
publication lifecycle. Later source edits do not rewrite earlier batches.

## Local runtime prerequisite

The restricted local concept runtime is now enabled; see [activation evidence](logo-local-activation-20261018.md). Initial concepts use the dedicated worker and Storage identity. No privileged Naming credential is reused as a logo role.

The existing protected OpenAI key returned HTTP 200 for metadata for the exact
configured `gpt-image-2.5-sunburst-2026-09-08` model on 2026-10-18. This is an
access check, not paid image inference or proof of a generated logo. The direct
Images API matches the documented single-prompt generation workflow:
[official image generation guide](https://developers.openai.com/api/docs/guides/image-generation).

## Validation boundaries

Local synthetic tests cover source ownership, revision races, selected aspects,
name handling, bounds and continuity into all six provider prompts. Provider,
transport, concept-plan, pricing and durable-worker tests retain the existing
request safeguards. Live acceptance completed on 2026-10-18: six actual concepts generated from the saved brand and two liked inspirations, committed and displayed after a full page reload. See the activation record for repairs, preserved failures and exact accounting.
