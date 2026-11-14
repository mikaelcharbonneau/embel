# Pattern: form validation

- Labels are always visible; placeholders give an example, never the label.
- Validate a field when the person leaves it, and all fields on submit.
- The message sits under its field in `color-text-danger` with an icon; the field takes `color-border-danger` and is linked to its message (`aria-describedby`, `aria-invalid`).
- On submit, focus moves to the first invalid field. The app's own messages replace the browser's validation bubble (`novalidate`).
- Buttons are not disabled to signal an incomplete form; they explain on press.
- Passwords are not cleared after a failed sign-in unless security requires it. Fields are not disabled while a request runs; the button shows loading and focus stays.
