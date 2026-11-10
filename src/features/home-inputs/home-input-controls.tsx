"use client";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { attachmentMimeTypeSchema, type AttachmentPolicy, type DraftAttachment } from "@/domain/attachments";
import { HomeVoiceControl } from "./home-voice-control";
import { AttachmentPicker } from "./attachment-picker";
import type { HomeVoiceAdapter } from "./voice-contract";
import { validateAttachmentSelection, type HomeAttachmentAvailability } from "./attachment-draft";
import { emptyHomeInputIntent, type HomeInputSession } from "./home-input-session";
export type HomeInputControlsProps = {
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
  compact?: boolean;
};
const empty = () => null;
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
  compact = false,
}: HomeInputControlsProps) {
  const [pickerRevision, setPickerRevision] = useState(0);
  const [voiceActivatedFor, setVoiceActivatedFor] = useState<string | null>(null);
  const read = useCallback(() => (account ? memory.get(account) : null), [memory, account]);
  const intent = useSyncExternalStore(memory.subscribe, read, empty);
  const readSelection = useCallback(() => (account ? memory.getSelection(account) : null), [memory, account]);
  const selection = useSyncExternalStore(memory.subscribe, readSelection, empty);
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
    <div className={`home-input-controls ${compact ? "home-input-controls--compact" : ""}`}>
      <HomeInputPopover
        className="home-files-popover"
        label="Add files or images"
        trigger={
          <>
            <Icon name="plus" size={compact ? 22 : 20} />
            <span className={compact ? "sr-only" : undefined}>Add files or images</span>
          </>
        }
      >
        <AttachmentPicker
          key={`${sessionFence}:${pickerRevision}`}
          files={files}
          policy={policy}
          availability={
            account
              ? availability
              : {
                  status: "unavailable",
                  reason: "Sign in to save verified input files. Your typed prompt stays available.",
                }
          }
          busy={busy}
          onAdd={add}
          onRemove={(localId) => {
            if (!account || busy) return;
            const current = memory.get(account);
            if (current)
              memory.set(account, { ...current, files: current.files.filter((file) => file.localId !== localId) });
          }}
        />
      </HomeInputPopover>
      <HomeInputPopover
        key={sessionFence}
        onOpen={() => setVoiceActivatedFor(sessionFence)}
        className="home-voice-popover"
        label="Voice input"
        trigger={<Icon name="mic" size={compact ? 22 : 20} />}
      >
        {voiceActivatedFor === sessionFence && (
          <HomeVoiceControl
            key={sessionFence}
            value={value}
            onChange={onChange}
            language={language}
            sessionFence={sessionFence}
            adapter={voiceAdapter}
            disabled={disabled || !!intent?.saveIntent}
          />
        )}
      </HomeInputPopover>
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
            Start a new attached brief
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

/** Voice initializes only on explicit activation, then stays mounted on dismissal. */
function HomeInputPopover({
  className,
  label,
  trigger,
  children,
  onOpen,
}: {
  className: string;
  label: string;
  trigger: ReactNode;
  children: ReactNode;
  onOpen?: () => void;
}) {
  const root = useRef<HTMLDetailsElement>(null),
    summary = useRef<HTMLElement>(null),
    id = useId();
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (root.current?.open && !root.current.contains(event.target as Node)) root.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !root.current?.open) return;
      event.preventDefault();
      root.current.open = false;
      summary.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <details ref={root} className={`home-input-popover ${className}`}>
      <summary
        ref={summary}
        id={id}
        aria-label={label}
        title={label}
        onClick={() => {
          if (!root.current?.open) onOpen?.();
          if (!root.current?.open)
            root.current
              ?.closest(".home-input-controls")
              ?.querySelectorAll<HTMLDetailsElement>(".home-input-popover")
              .forEach((popover) => {
                if (popover !== root.current) popover.open = false;
              });
        }}
      >
        {trigger}
      </summary>
      <div className="home-input-popover-panel" role="region" aria-labelledby={id}>
        {children}
      </div>
    </details>
  );
}
