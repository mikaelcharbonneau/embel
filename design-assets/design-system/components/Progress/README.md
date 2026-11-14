# Spinner, progress bar, thinking indicator

The three ways Embel shows work in progress. You provide the status sentence.

- **Spinner** (16 or 20 px): inside the button that was pressed, within 100 ms. The label stays.
- **Progress bar** (4 px): AI work that takes seconds or minutes. It sits where the result will appear, with one plain sentence and a Stop control. States: running, stopping, done, failed. It shows no percentage.
- **Thinking indicator**: the Embel mark pulsing beside "Thinking…" while the assistant composes a reply.
- Loops: spin 0.8 s, sweep 2.4 s, pulse 1.6 s. Under reduced motion the spinner pulses instead of turning and the bar is a static filled track; the sentence carries the status.
