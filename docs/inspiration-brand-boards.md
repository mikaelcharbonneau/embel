# Inspiration brand boards — sourcing brief (November 7, 2026)

The Inspiration step (Identity 1 of 3, now shown inside the project
conversation) should only show **brand boards**: one image per brand that shows
several parts of a real identity together. Today's 30 catalog images are single
applications or plain logos (agency case-study photos and Simple Icons
studies) and will be replaced.

Decision (November 7): use **real studio brand boards**, with the studio's
permission, rather than generated ones.

## What every image must show

At least four of these, legible at gallery size (about 250 px wide in the chat):

- the logo or wordmark,
- the typeface(s), with a type specimen or headline,
- the color palette (swatches or clearly dominant colors),
- graphic elements (patterns, shapes, illustration, iconography),
- product or brand applications (packaging, signage, screens, print, merch).

Avoid: a single photo of one application, a logo alone, template or mock-up
kits, freelancer "brand guideline templates", and boards where text is too
small to read at gallery size.

## Mix (24 boards)

Aim for variety so a founder can recognize a direction:

| Style | Count | Examples of sectors |
| --- | --- | --- |
| Minimal / Swiss / monochrome | 3 | tech, architecture, finance |
| Warm and approachable | 3 | food, cafés, wellness |
| Bold and colorful | 3 | consumer apps, sport, entertainment |
| Premium / luxury / serif-led | 3 | beauty, fashion, hospitality |
| Organic / natural / earthy | 3 | farming, skincare, home goods |
| Playful / illustrated | 3 | kids, games, snacks |
| Retro / heritage | 2 | drinks, crafts, local shops |
| Editorial / cultural | 2 | publishing, museums, events |
| Tech / product / SaaS | 2 | software, fintech, AI |

## Where to look

Professional studios that publish identity overviews in their case studies,
for example: Pentagram, COLLINS, Koto, Mucho, Porto Rocha, Order, Base Design,
Studio Dumbar/DEPT®, Lundgren+Lindqvist, Manual, Mother Design, Character,
DesignStudio, Ragged Edge, Wolff Olins, Gretel. Curated galleries (Behance
"Branding" curated, BP&O, Brand New) are good for discovery, but always license
from the studio that owns the work.

## What to collect for each image

These map directly to the catalog (`src/domain/inspiration-catalog.json`):

- brand name and studio (credit line, for example "Ferm · Koto"),
- the case-study page URL (shown as "View original project"),
- the image file at 1600 px or wider (landscape 3:2 or 4:3 works best),
- a one-sentence plain description (for screen readers and search),
- three or four style tags (for example "serif", "earthy", "packaging"),
- which parts it shows (logo, typography, colors, graphics, photography, layout),
- the permission: who granted it, when, any credit wording or conditions.

## Permission request (template)

> Subject: Permission to feature your [Brand] identity in Embel
>
> Hi [Name],
>
> I'm building Embel, an app that helps founders turn an idea into a usable
> brand. In one step, founders browse a small set of real identities and like
> the ones they're drawn to; their likes guide their own, original logo.
>
> We'd love to include your [Brand] identity as one of about 24 references, using
> [the overview image from your case study / one image you choose], credited as
> "[Brand] · [Studio]" with a link to your case study. It's shown for inspiration
> only, never copied, resold or used to train models, and we'll remove it on
> request.
>
> Would that be OK? If you prefer a specific image or credit wording, just say.
>
> Thank you,
> [Your name]

## Swapping them in

Once images and permissions are in hand, the change is small: replace the files
in `public/inspiration/`, rewrite the catalog entries, mark every entry with all
the elements it shows, bump `INSPIRATION_CATALOG_VERSION`, and drop the
"Identities / Logos" filter (every image will be a board). Likes saved on
images that are removed must be migrated or cleared at the same time: the
catalog check rejects a saved choice whose image no longer exists (existing
projects are test data, so clearing is fine before launch).
