# Pattern: destructive confirmation

- A small Dialog. The title names the action and the object ("Delete Orchard Lane Cider?").
- The body says what is lost and whether it can be undone.
- Focus starts on Cancel. The confirming button is the only danger-filled button in the product and repeats the verb ("Delete project").
- Reversible actions (deleting a project) can skip heavy confirmation in favour of a Toast with Undo; irreversible ones (deleting an account) ask the person to type a word.
- While the action runs, the button shows the loading state and the dialog stays open; a failure appears inside the dialog.
