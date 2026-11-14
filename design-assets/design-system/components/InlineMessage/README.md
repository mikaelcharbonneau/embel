# Inline message

The one way to tell the person something in place. You provide the tone, the words and, where there is one, the action that recovers.

- Tones: **neutral** (information; no blue), **positive**, **warning**, **danger**.
- Forms: **field** (text under a field), **block** (in a card or section, with an optional title, actions and dismiss), **banner** (full width under the navigation).
- Always an icon plus text; colour is never the only signal. Body text is `color-text` on the soft fill; only field-level text takes the tone colour.
- Say what happened in the person's terms and what to do next. The recovery action is a secondary Button inside the message, never a faint link.
- Danger and warning use `role="alert"`; neutral and positive use `role="status"`.
- Errors are never toasts and never bare coloured text. A positive block is for outcomes that matter after the moment ("Payment confirmed"); a passing confirmation is a Toast.
