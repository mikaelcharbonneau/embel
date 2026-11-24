"use client";
import { useRef, useState } from "react";
import { IconButton } from "@/components/ui/button";
import type { AttachmentPolicy, DraftAttachment } from "@/domain/attachments";
import { validateAttachmentSelection, type HomeAttachmentAvailability } from "./attachment-draft";
type AttachmentPickerProps = {
  files: readonly DraftAttachment[];
  policy: AttachmentPolicy | null;
  availability: HomeAttachmentAvailability;
  busy: boolean;
  onAdd(files: readonly File[]): Promise<void>;
  /** Shown with the reason when files need an account. */
  onSignIn?: () => void;
};
const kinds = {
  "text/plain": "plain text",
  "application/pdf": "PDF",
  "image/png": "PNG",
  "image/jpeg": "JPEG",
} as const;
const megabytes = (bytes: number) => `${Math.floor(bytes / 1_048_576)} MB`;
/** The attach button of the prompt box: one press opens the device's file chooser. Chosen files show as
 * chips in the box (`HomeAttachmentChips`). */
export function AttachmentPicker({ files, policy, availability, busy, onAdd, onSignIn }: AttachmentPickerProps) {
  const input = useRef<HTMLInputElement>(null),
    [errors, setErrors] = useState<string[]>([]),
    [reading, setReading] = useState(false),
    [explain, setExplain] = useState(false);
  const available = availability.status === "available" && policy !== null;
  return (
    <>
      <input
        ref={input}
        hidden
        type="file"
        multiple
        accept={policy?.allowedMimeTypes.join(",")}
        disabled={!available || busy || reading}
        onChange={async (event) => {
          const filesToAdd = [...(event.target.files ?? [])];
          event.target.value = "";
          if (!available || !policy || busy || reading) return;
          const result = validateAttachmentSelection(filesToAdd, files, policy);
          setErrors(
            result.errors.map(
              (error) =>
                `${error.name}: ${
                  error.code === "count"
                    ? `you can add up to ${policy.maxFiles} files`
                    : error.code === "mime"
                      ? `this kind of file isn’t supported (use ${policy.allowedMimeTypes.map((type) => kinds[type]).join(", ")})`
                      : error.code === "total_bytes"
                        ? `together the files are over ${megabytes(policy.maxTotalBytes)}`
                        : `the file is empty or over ${megabytes(policy.maxFileBytes)}`
                }.`,
            ),
          );
          if (!result.accepted.length) return;
          setReading(true);
          try {
            await onAdd(result.accepted);
          } catch {
            setErrors((previous) => [
              ...previous,
              "Some files could not be read. Your prompt and other files are kept.",
            ]);
          } finally {
            setReading(false);
          }
        }}
      />
      <IconButton
        className="home-attach-button"
        icon="plus"
        label="Add files or images"
        tooltip={false}
        title="Add files or images"
        disabled={available && (busy || reading)}
        onClick={() => {
          if (available) input.current?.click();
          else setExplain(true);
        }}
      />
      {explain && !available && (
        <p className="home-input-note" role="status">
          {availability.status === "unavailable" ? availability.reason : "Files can’t be added right now."}
          {onSignIn && (
            <>
              {" "}
              <button className="text-link" type="button" onClick={onSignIn}>
                Sign in
              </button>
            </>
          )}
        </p>
      )}
      {errors.map((error, index) => (
        <p className="home-input-note form-error" role="alert" key={`${index}:${error}`}>
          {error}
        </p>
      ))}
    </>
  );
}
