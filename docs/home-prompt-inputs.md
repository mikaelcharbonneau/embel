# Home prompt: attach and dictate

_November 24, 2026._ The Home prompt box has two buttons beside Send. Each acts on one press.

## Dictate (microphone button)

- One press starts dictation; the words appear in the prompt as they are spoken; a second press stops.
  The prompt stays an ordinary editable text the whole time. Dictating never sends the prompt.
- It uses the browser's own speech recognition (`SpeechRecognition`, or `webkitSpeechRecognition` in
  Safari and older Chromium), in the browser's language. Embel does not record, upload or store audio,
  and no AI provider or credit is involved.
- Where the browser can turn speech into text on the device, that is used and the status line says so.
  Otherwise the browser uses its own speech service (as its built-in dictation does) and the status line
  says the audio may be sent there. Before November 24 only the on-device path was allowed, which made
  the button unavailable in almost every browser.
- A browser without speech recognition (Firefox today) gets a plain message on press; typing still works.
- Code: `src/features/home-inputs/browser-voice-adapter.ts` (the browser API), `use-home-voice.ts`
  (the modes: idle, starting, listening, stopping, error) and `home-voice-control.tsx` (the button).
  `next.config.ts` allows the microphone for this site only.

## Attach (plus button)

- One press opens the device's file chooser. Chosen files show as chips inside the box and can be removed.
  Limits come from the server's policy: up to 5 files, 10 MB each, 25 MB together; PNG, JPEG and plain
  text (PDF is not accepted yet, see `src/server/home-attachments/README.md`).
- Files need an account: signed out, the button says so and offers sign-in (the typed prompt is kept).
- Send works as it does without files: one click saves the brand, and competitor research starts by
  itself. The files are uploaded and linked to the brand in the same save
  (`saveAttachedHomeDraft`, `src/features/home-inputs/home-input-session.ts`); the first research turn is
  saved with the project (`firstTurnContext` in `account-strategy-start.tsx`), so the project page starts
  research exactly as for a prompt without files. If research is unavailable at that moment the brand
  still opens, ready to start.
- **Known limit:** the AI does not read attached files yet. They are stored privately with the brand, and
  the note under the box says research works from the written prompt. Which steps should use them
  (research, naming, logo references) is an open product decision.
- Code: `attachment-picker.tsx` (button and checks), `home-input-controls.tsx` (`HomeAttachmentChips`,
  `HomeInputControls`), server side unchanged (`src/server/home-attachments`, `/api/home/attachments`).

## Tests

- `tests/client/home-inputs.test.ts`, `home-input-buttons.test.tsx`, `home-inputs-integration.test.ts`.
- The full-journey browser test has a second test that dictates (with a stand-in for the browser's
  speech recognition), attaches a file and checks that research starts without another click.
