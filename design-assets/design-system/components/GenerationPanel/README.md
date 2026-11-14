# Generation panel

What the person sees while AI work runs. Assembled from Card, the progress bar, Button and Inline message.

- One plain sentence that names the work, and a Stop control. No percentages, no cost estimates.
- It occupies the place and size of the result, so the page does not shift when the result arrives.
- A failure is a danger Inline message in the same place, with the recovery action as a button ("Retry 2 failed concepts").
- Finished results fade in over `duration-slow`, 40 ms apart (`stagger`).
