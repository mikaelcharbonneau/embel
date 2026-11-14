# Focus ring

The outline that shows which control the keyboard is on. One ring, everywhere.

- Two parts: a 2 px ring in `focus-ring-color` (ink) with a 2 px halo in `focus-ring-halo` (paper) outside it. On light surfaces the ink carries it; on dark artwork the halo does.
- Two offsets only: `focus-ring-offset` (2 px, outside a free-standing control) and `focus-ring-inset` (-2 px, inside a control that fills a clipped box, such as a gallery tile).
- A text-entry frame shows the ring whenever the field inside it has focus.
- On an ink surface (toast, tooltip) the ring flips: a paper ring with an ink halo.
- No component removes the ring without this replacement. It appears instantly and does not animate.
