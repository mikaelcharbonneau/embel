# Navigation: floating pill and project bar

The app's two bars. You provide the current destination, or the project and the state of its four steps.

- **App navigation**: the Embel mark and wordmark, the three destinations (Home, Projects, Library) and the account button. Signed out, the account area holds "Sign in" and "Create account".
- **Project bar**: the mark (home), the project switcher, the four journey steps (Strategy, Voice, Identity, Assets) and the save status.
- 56 px tall (`nav-height`), `radius-pill`, `shadow-raised`, `z-nav`, 16 px from the top (`nav-offset`).
- Item states: default, hover, focus-visible, active, selected, disabled. A selected destination in the navigation pill (`aria-current`) has an ink fill.
- Steps (refined November 13): the current step has no fill. Its mark, an ink ring with a dot, and its ink name show it; the other steps' names are `color-text-muted`. Complete steps have a filled ink tick, not-reached steps a number (`aria-disabled`, disabled text). Hover shows the light pill on any step that can be opened.
- Loading: while the session is checked, the account area holds a skeleton of the same width, so the pill does not change size.
- Compact: destinations become icons that keep their accessible names. Below 1024 px the steps collapse into one menu button ("Identity · 3 of 4") that opens a Menu of the four steps.
- "Saved" appears only after the server confirms.
- Fixed chrome (added November 12 for D-054): the bar is 72 px with its offset. In a window under 600 px tall the reply box is not docked and the Section bar is not sticky, so fixed chrome is the bar alone: 16% of a 450 px window.
