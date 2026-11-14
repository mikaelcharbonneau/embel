# Motion

Tokens: `duration-fast` 120 ms, `duration-press` 160 ms, `duration-base` 200 ms, `duration-slow` 300 ms; loops `duration-loop-pulse` 1.6 s, `duration-loop-spin` 0.8 s, `duration-loop-sweep` 2.4 s; `ease-out`, `ease-in-out`, `ease-drawer`; `press-scale` 0.97, `enter-scale` 0.97, `enter-shift` 4 px, `stagger` 40 ms.

- Frequency decides: route changes, tabs, typing and Escape do not animate.
- Only opacity and transform move. Colour, border and background may fade over `duration-fast` with the keyword `ease`.
- Entrances animate; exits are instant. Nothing already on screen moves because something else loaded.
- Every action shows a change within 100 ms on the control that was pressed.
- Hover effects exist only where a pointer can hover (`hover: hover` and `pointer: fine`). Nothing is reachable by hover alone.
- Never `ease-in`. Nothing a person triggers takes longer than `duration-slow`.
- **Reduced motion** removes movement and keeps feedback: scales become 1, shifts and stagger 0, fades stay at 120 ms, the skeleton keeps its pulse, the spinner pulses, and the progress bar is a static filled track.
