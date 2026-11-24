"use client";
import { useCallback, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/icon";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { attachmentMimeTypeSchema, type AttachmentPolicy, type DraftAttachment } from "@/domain/attachments";
import { HomeVoiceControl } from "./home-voice-control";
import { AttachmentPicker } from "./attachment-picker";
import type { HomeVoiceAdapter } from "./voice-contract";
import { validateAttachmentSelection, type HomeAttachmentAvailability } from "./attachment-draft";
import { emptyHomeInputIntent, type HomeInputSession } from "./home-input-session";
type HomeInputControlsProps = {
  account: VerifiedAccount | null;
  sessionFence: string;
  memory: HomeInputSession;
  value: string;
  onChange(value: string): void;
  language: string;
  voiceAdapter: HomeVoiceAdapter;
  policy: AttachmentPolicy | null;
  availability: HomeAttachmentAvailability;
  disabled: boolean;
  /** Offered when someone signed out asks to add files. */
  onSignIn?: () => void;
};
const empty = () => null;
/** The files attached to the prompt in this tab, and whether they may change right now. */
function useHomeFiles(memory: HomeInputSession, account: VerifiedAccount | null, disabled: boolean) {
  const read = useCallback(() => (account ? memory.get(account) : null), [memory, account]);
  const intent = useSyncExternalStore(memory.subscribe, read, empty);
  const files: DraftAttachment[] =
    intent?.files.map((file) => ({
      localId: file.localId,
      name: file.file.name,
      mimeType: file.upload.mimeType,
      byteLength: file.file.size,
      state:
        file.outcome === "verified"
          ? "uploaded"
          : file.outcome === "pending"
            ? "uploading"
            : file.outcome === "failed"
              ? "error"
              : file.outcome,
      ownedRef: file.receipt,
    })) ?? [];
  const selecting = useSyncExternalStore(memory.subscribe, memory.isSelecting, () => false);
  const busy =
    selecting ||
    disabled ||
    !!intent?.saveIntent ||
    files.some((file) => file.state === "uploading" || file.state === "uncertain");
  return { intent, files, busy };
}
const chipStatus = {
  local: "",
  uploading: "Uploading…",
  uploaded: "",
  uncertain: "Checking…",
  error: "Couldn’t upload",
};
/** The attached files, shown inside the prompt box above its buttons. */
export function HomeAttachmentChips({
  account,
  memory,
  disabled,
}: {
  account: VerifiedAccount | null;
  memory: HomeInputSession;
  disabled: boolean;
}) {
  const { files, busy } = useHomeFiles(memory, account, disabled);
  if (!files.length) return null;
  return (
    <ul className="home-attachment-chips" aria-label="Attached files">
      {files.map((file) => (
        <li key={file.localId} data-state={file.state}>
          <Icon name={file.mimeType.startsWith("image/") ? "image" : "file-text"} size="sm" />
          <span className="home-attachment-name">{file.name}</span>
          {chipStatus[file.state] && <span className="home-attachment-status">{chipStatus[file.state]}</span>}
          <button
            type="button"
            className="home-attachment-remove"
            aria-label={`Remove ${file.name}`}
            title={`Remove ${file.name}`}
            disabled={busy}
            onClick={() => {
              if (!account || busy) return;
              const current = memory.get(account);
              if (current)
                memory.set(account, {
                  ...current,
                  files: current.files.filter((item) => item.localId !== file.localId),
                });
            }}
          >
            <Icon name="x" size="sm" />
          </button>
        </li>
      ))}
    </ul>
  );
}
export function HomeInputControls({
  account,
  sessionFence,
  memory,
  value,
  onChange,
  language,
  voiceAdapter,
  policy,
  availability,
  disabled,
  onSignIn,
}: HomeInputControlsProps) {
  const [pickerRevision, setPickerRevision] = useState(0);
  const { intent, files, busy } = useHomeFiles(memory, account, disabled);
  const readSelection = useCallback(() => (account ? memory.getSelection(account) : null), [memory, account]);
  const selection = useSyncExternalStore(memory.subscribe, readSelection, empty);
  async function add(selected: readonly File[]) {
    if (!account || !memory.isCurrent(account) || !policy || availability.status !== "available" || busy) return;
    const old = memory.get(account) ?? emptyHomeInputIntent();
    const checked = validateAttachmentSelection(selected, files, policy);
    if (checked.errors.length) throw new Error("Attachment bounds changed");
    const reader = memory.beginSelection(account, checked.accepted.length);
    if (!reader) return;
    try {
      let next = old;
      for (const file of checked.accepted) {
        const data = await file.arrayBuffer();
        if (!reader.current()) return;
        const digest = await crypto.subtle.digest("SHA-256", data);
        if (!reader.current()) return;
        const upload = {
          requestKey: crypto.randomUUID(),
          name: file.name,
          mimeType: attachmentMimeTypeSchema.parse(file.type),
          contentHash: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join(""),
        };
        next = {
          ...next,
          files: [...next.files, { localId: crypto.randomUUID(), file, upload, receipt: null, outcome: "local" }],
        };
        if (!memory.set(account, next)) return;
      }
      reader.complete();
    } finally {
      reader.interrupt();
    }
  }
  return (
    <div className="home-input-controls">
      <AttachmentPicker
        key={`${sessionFence}:${pickerRevision}`}
        files={files}
        policy={policy}
        availability={
          account ? availability : { status: "unavailable", reason: "Files can be added once you’re signed in." }
        }
        busy={busy}
        onAdd={add}
        onSignIn={account ? undefined : onSignIn}
      />
      <HomeVoiceControl
        key={sessionFence}
        value={value}
        onChange={onChange}
        language={language}
        sessionFence={sessionFence}
        adapter={voiceAdapter}
        disabled={disabled || !!intent?.saveIntent}
      />
      {intent?.saveOutcome === "confirmed" && (
        <p role="status">
          These files were saved with your brand.{" "}
          <button
            className="text-link"
            type="button"
            disabled={disabled}
            onClick={() => {
              if (account) memory.set(account, emptyHomeInputIntent());
            }}
          >
            Start a new prompt with files
          </button>
        </p>
      )}
      {selection && (
        <div role="status">
          <p>
            {selection.status === "interrupted"
              ? "File selection was interrupted. Ready files are kept. Cancel the pending selection, then choose any remaining files again."
              : `Reading ${selection.fileCount} selected ${selection.fileCount === 1 ? "file" : "files"}…`}
          </p>
          <button
            className="text-link"
            type="button"
            disabled={disabled}
            onClick={() => {
              if (account && memory.cancelSelection(account, selection.id)) setPickerRevision((value) => value + 1);
            }}
          >
            Cancel pending file selection
          </button>
        </div>
      )}
    </div>
  );
}
