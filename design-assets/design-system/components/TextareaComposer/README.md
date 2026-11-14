# Textarea and composer

Multi-line text entry. You provide the label or placeholder, and for a composer the actions it offers.

- **Textarea**: the Text field's frame, auto-growing between three and ten lines. Same states and error rules as Text field.
- **Composer**: a text area plus an actions row (add files, voice, send). Used for the Home prompt (`text-body-lg`), the reply box and "describe a change". Radius `radius-panel`; `shadow-raised` only when it floats over the page.
- Focus: the standard two-part ring is drawn on the frame whenever the text area inside has focus. The inner control never shows a second ring.
- While a request runs, the send button becomes a stop button. The composer is not disabled, so focus stays.
- The send button is the only primary Icon button. It is disabled only when there is nothing to send.
