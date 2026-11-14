# Text field

A single-line input with its label, optional hint and error text. You provide the label, the input type and, where useful, a hint and a placeholder example.

- Types: text, email, password (built-in show toggle), search (leading icon and a clear button), number.
- The label is always visible, above the field. The placeholder is an example in `color-text-placeholder`, never the label.
- Outline: `color-border-control`. It becomes `color-border-selected` on hover and focus, and `color-border-danger` when invalid.
- Error: the message sits under the field with an icon, in `color-text-danger`, and is linked with `aria-describedby`. Set `aria-invalid="true"` on the input.
- Loading is a status line under the field, never a value written into it.
- Disabled uses `color-bg-disabled` and `color-text-disabled`; read-only keeps ink text on `color-bg-sunken`.
- Height 44 px. Text is 16 px at every width, so phones do not zoom on focus. Maximum width 480 px (`field-max`) at medium and wide widths.
