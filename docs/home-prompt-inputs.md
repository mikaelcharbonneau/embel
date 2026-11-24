# Home prompt: attach and dictate, and how attached files are used

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
- Nothing of the browser's speech system is touched before the button is pressed. Asking about
  on-device speech at page load crashed the headless Chromium that CI uses.
- A browser without speech recognition (Firefox today) gets a plain message on press; typing still works.
- Code: `src/features/home-inputs/browser-voice-adapter.ts` (the browser API), `use-home-voice.ts`
  (the modes: idle, starting, listening, stopping, error) and `home-voice-control.tsx` (the button).
  `next.config.ts` allows the microphone for this site only.

- **Also in the side chat.** The reply box inside a brand (`WorkspaceReplyBox`) has the same button,
  just before Send; it is off while a message is being saved or Embel works.

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
- Code: `attachment-picker.tsx` (button and checks), `home-input-controls.tsx` (`HomeAttachmentChips`,
  `HomeInputControls`), server side unchanged (`src/server/home-attachments`, `/api/home/attachments`).

## Attach in the side chat

The reply box inside a brand has the same plus button and chips (November 24).

- On Send the chosen files are uploaded and verified (the same upload as on Home), added to the brand
  (`public.attach_home_files_to_project`, `POST /api/projects/[id]/brief-files`), and read by Embel
  (kind `brief.read_files`, no credits, started through `/generations`). Then the typed message, if
  any, goes out as usual. Files alone never move a step forward.
- A brand holds at most 5 files and 25 MiB in all, counting those added on Home; the database function
  enforces it and the button says so when the brand is full.
- The reading reads all the brand's files again (so the newest reading always covers every file) and
  is saved as that run's `files` output. If it fails, is stopped or takes over 200 seconds, the
  message still goes out; the files stay with the brand and the next Strategy step reads them.
- Limits: files added during Logo or Creative direction are read and listed, but those steps do not
  use them yet. Files cannot be removed from a brand.
- Code: `use-chat-attachments.ts` (the flow), `WorkspaceReplyBox` (`attach`), `brief-files.ts`
  (`attachFilesToProject`, `buildBriefFilesRunInput`, `knownBriefFileNotes`),
  `src/workflows/brief-files.ts`, migration `20261124100000_attach_files_to_brand.sql`.

## What Embel does with attached files

Owner decisions, November 24: what a file is used for depends on what it turns out to be, and reading
files is free (Embel absorbs the cost).

- **One reading, on the brand's first Strategy run.** Before that run's own request, the workflow reads
  every file in one OpenAI request (text as text, the first 20,000 characters; images decoded in the
  isolated raster child and sent small, on white). The reply says for each file what it is
  (`notes`, `competitor_material`, `product_photo`, `visual_reference`, `existing_logo`, `other`) and
  gives a summary of at most 600 characters.
- **No credit, same limits.** The reading is part of the Strategy run that was admitted by
  `start_generation`, so the run's credits, daily limits, stop switches and cancel apply and nothing
  is charged for the reading itself. Its provider cost is recorded on the run's `files` output and
  counts toward the daily cost caps.
- **Saved once, reused.** The reading is the run's `files` output (`generation_outputs`). Every later
  Strategy run (audience, positioning, personality, slogan, replies) and every naming round is given
  it from there; the files are not read again. A file that cannot be opened or that the reply leaves
  out is marked unreadable, never guessed.
- **It never blocks the brand.** If the reading fails, is stopped or times out (3 minutes), the run
  goes ahead from the written brief, the attempt and its cost are recorded (`files.attempt`), and the
  next Strategy run reads the files again.
- **The person sees it.** Under the first prompt in the brand's conversation each file is listed with
  its kind and summary ("Reading…" while the first run works).
- **File text is data.** The reading request and the later prompts treat file contents and summaries
  as untrusted task data, like the rest of the brief.

Not done yet: images are not passed to Logo or Creative direction as references, an existing logo is
not offered at the Logo step, and a reading cannot be corrected or removed by the person.

Code: `src/domain/brief-files.ts` (shapes), `src/server/engine/brief-files.ts` (owner-side lookups),
`src/server/engine/brief-files-run.ts` and `src/workflows/brief-files-steps.ts` (the reading),
`src/workflows/strategy.ts` (`readAttachedFiles`), `withAttachedFiles` in `strategy-run.ts`,
`attachedFiles` in `naming.ts` and `naming-prompt.ts`, `GET /api/projects/[id]/brief-files` and
`src/features/home-inputs/brief-files.tsx` (the list in the conversation).

## Tests

- `tests/client/home-inputs.test.ts`, `home-input-buttons.test.tsx`, `home-inputs-integration.test.ts`.
- `tests/server/engine-brief-files.test.ts` (the reading).
- The full-journey browser test has a second test that dictates (with a stand-in for the browser's
  speech recognition), attaches a file and checks that research starts without another click, that
  the file's reading is shown, that research was given it, and that only research's credits were charged.
