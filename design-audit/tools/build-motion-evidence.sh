#!/usr/bin/env bash
# Rebuilds the pass 2 evidence images (design-audit/evidence/annotated/M-xxx.png) from the frames that
# the walk scripts saved in design-audit/evidence/motion/frames/. Run from the repository root:
#   bash design-audit/tools/build-motion-evidence.sh
set -euo pipefail
A=design-audit/evidence/annotated
sheet() { node design-audit/tools/contact-sheet.mjs "$@" >/dev/null && echo "built $1"; }

sheet $A/M-003.png "M-003. Overlays appear in one frame (1440). Sign-in overlay, delete dialog, account menu: the frame at the click and the next frame" \
  shell__signed-out-sign-in-overlay__1440__10-open-overlay-from-pill-24ms shell__signed-out-sign-in-overlay__1440__11-open-overlay-from-pill-81ms \
  shell__projects-list__1440__07-choose-delete-0ms shell__projects-list__1440__08-choose-delete-80ms \
  shell__account-menu__1440__00-open shell__account-menu__1440__01-open --cols=2 --width=640

sheet $A/M-004.png "M-004. Research in progress. Top: normal motion, the bar sweeps. Bottom: reduced motion, nothing on the page moves. Two frames 1.4 s apart" \
  live__research-live__1440__09-research-running-0ms live__research-live__1440__11-research-running-1400ms \
  live__research-live-reduced-motion__1440__09 live__research-live-reduced-motion__1440__11 --cols=2 --width=640

sheet $A/M-005.png "M-005. Inspiration. Left: hover at 1440 shows a part's heart and label. Right: at 390 with touch they stay hidden" \
  brand__inspiration-gallery__1440__13-hover-brand-tile-300ms brand__inspiration-gallery__390__06-like-brand-0ms --cols=2 --width=640

sheet $A/M-006.png "M-006. Seven ways of saying 'working': spinner, skeleton, sweep bar, shader, 'Preparing…' boxes, one line of text, pulsing mark" \
  shell__sign-in-page__1440__11-submit-wrong-password-1202ms shell__projects-list__1440__31-reload \
  live__research-live__1440__11-research-running live__logos-live__1440__10-drawing-1000ms \
  brand__assets-page__1440__01-load-assets-700ms brand__assets-page__1440__00-load-assets-200ms \
  brand__kestrel-direct-load__1440__12-change-name-300ms --cols=4 --width=420

sheet $A/M-007.png "M-007. Messages inserted into the page push it. Delete project (before, and after the notice appears); Retry with no credits (before, after)" \
  live__delete-project__1440__04-confirm-delete-600ms live__delete-project__1440__06-confirm-delete-2500ms \
  brand__logo-concepts__1440__12-click-retry-with-zero-credits-0ms brand__logo-concepts__1440__15-click-retry-with-zero-credits-700ms --cols=2 --width=640

sheet $A/M-008.png "M-008. Signed in, but a finished brand first shows the signed-out screen ('Project workspace', 'Back to Projects'). 1440 and 390, at 150 ms and 1 s" \
  brand__kestrel-direct-load__1440__00-direct-load-150ms brand__kestrel-direct-load__1440__02-direct-load-1000ms \
  brand__kestrel-direct-load__390__00-direct-load-150ms brand__kestrel-direct-load__390__02-direct-load-1000ms --cols=2 --width=640

sheet $A/M-009.png "M-009. Home to Projects (0 to 900 ms), then clearing the search box (0 to 800 ms): the skeleton returns each time and cards fill in three steps" \
  shell__nav-route-changes__1440__06-home-to-projects shell__nav-route-changes__1440__07-home-to-projects shell__nav-route-changes__1440__08-home-to-projects \
  shell__nav-route-changes__1440__09-home-to-projects shell__nav-route-changes__1440__10-home-to-projects \
  shell__projects-list__1440__23-clear-search shell__projects-list__1440__24-clear-search shell__projects-list__1440__25-clear-search shell__projects-list__1440__26-clear-search --cols=5 --width=330

sheet $A/M-010.png "M-010. 390: the account menu is open (first frame). A tap outside closes it AND opens the project that was under the finger" \
  shell__account-menu__390__03-open-account-menu-500ms shell__account-menu__390__07-outside shell__account-menu__390__08-outside --cols=3 --width=390

sheet $A/M-012.png "M-012. Library, click 'View details': frames at 0, 150, 500 and 1200 ms. No panel is ever visible" \
  shell__library__1440__15-view-details shell__library__1440__16-view-details shell__library__1440__17-view-details shell__library__1440__18-view-details --cols=4 --width=420

sheet $A/M-013.png "M-013. Opening a finished brand at 1440: 150 ms to 7 s. The view lands in the middle of the Inspiration gallery and moves again" \
  brand__kestrel-direct-load__1440__00 brand__kestrel-direct-load__1440__01 brand__kestrel-direct-load__1440__02 brand__kestrel-direct-load__1440__03 \
  brand__kestrel-direct-load__1440__04 brand__kestrel-direct-load__1440__05 brand__kestrel-direct-load__1440__06 brand__kestrel-direct-load__1440__07 --cols=4 --width=420

sheet $A/M-013-390.png "M-013. Opening a finished brand at 390: 150 ms to 7 s" \
  brand__kestrel-direct-load__390__00 brand__kestrel-direct-load__390__01 brand__kestrel-direct-load__390__02 brand__kestrel-direct-load__390__03 \
  brand__kestrel-direct-load__390__04 brand__kestrel-direct-load__390__05 brand__kestrel-direct-load__390__06 brand__kestrel-direct-load__390__07 --cols=8 --width=220

sheet $A/M-014.png "M-014. Continue from Inspiration to Logo: 0 ms to 3 s. The step first shows faded options and instructions for an empty state" \
  brand__out-of-credits-and-disabled__1440__00-continue brand__out-of-credits-and-disabled__1440__01-continue brand__out-of-credits-and-disabled__1440__02-continue \
  brand__out-of-credits-and-disabled__1440__03-continue brand__out-of-credits-and-disabled__1440__04-continue brand__out-of-credits-and-disabled__1440__05-continue \
  brand__out-of-credits-and-disabled__1440__06-continue --cols=4 --width=420

sheet $A/M-015.png "M-015. Top: choosing a direction (before, 0, 80, 450, 900, 1800 ms). Bottom: selecting a logo concept (before, 0, 200, 450, 900, 1800 ms). The ring arrives about a second late" \
  live__choose-direction__1440__00 -choose-direction-0ms -choose-direction-80ms -choose-direction-450ms -choose-direction-900ms -choose-direction-1800ms \
  live__select-concept__1440__00 -select-concept-1-0ms -select-concept-1-200ms -select-concept-1-450ms -select-concept-1-900ms -select-concept-1-1800ms --cols=6 --width=300

sheet $A/M-016.png "M-016. 'More concepts' (0 ms to 6 s): nothing new for about 3 s, then the six logos are swapped for placeholders. Then 'Stop' (0 ms to 8 s): no visible change" \
  live__logos-live__1440__00 live__logos-live__1440__02 live__logos-live__1440__04 live__logos-live__1440__05 live__logos-live__1440__06 \
  live__logos-live__1440__13-click-stop live__logos-live__1440__15-click-stop live__logos-live__1440__17-click-stop live__logos-live__1440__19-click-stop live__logos-live__1440__20-click-stop --cols=5 --width=330

sheet $A/M-018.png "M-018. Larger view of a direction board at 1440: the dialog opens small with a placeholder, then jumps to full size" \
  brand__directions__1440__10-open-larger-view brand__directions__1440__11-open-larger-view --cols=2 --width=640

sheet $A/M-019.png "M-019. Assets page at 1440: 200 ms, 700 ms, 1.5 s (the brand board is inserted above and everything moves down), then 'Download brand kit' at 0 and 700 ms" \
  brand__assets-page__1440__00-load brand__assets-page__1440__01-load brand__assets-page__1440__02-load \
  brand__assets-page__1440__14-download-brand-kit-0ms brand__assets-page__1440__17-download-brand-kit-700ms --cols=5 --width=330
