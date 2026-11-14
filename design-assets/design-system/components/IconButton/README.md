# Icon button

A round control that shows only an icon. You provide the icon, an accessible name (`aria-label`) and a tooltip with the same words.

- **Outlined** on paper or canvas, **quiet** inside toolbars and dialog headers, **on-artwork** (a paper chip at 92%) for anything drawn on an image.
- Toggle form (heart, show password): set `aria-pressed`. Pressed is an ink fill with a white icon, so it never relies on colour alone.
- **Primary** is reserved for the send button in a composer.
- 44 px; 36 px on pointer devices, with the 44 px target kept by its hit area.
- The focus ring is the two-part ring; on dark artwork the paper halo is what keeps it visible.
