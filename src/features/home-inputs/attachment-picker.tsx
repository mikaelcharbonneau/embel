"use client";
import { ContextDetails } from "@/components/ui/context-details";
import { useId, useState } from "react";
import type { AttachmentPolicy, DraftAttachment } from "@/domain/attachments";
import { validateAttachmentSelection, type HomeAttachmentAvailability } from "./attachment-draft";
export type AttachmentPickerProps = { files: readonly DraftAttachment[]; policy: AttachmentPolicy | null; availability: HomeAttachmentAvailability; busy: boolean; onAdd(files: readonly File[]): Promise<void>; onRemove(localId: string): void };
const labels = { local: "In this tab", uploading: "Upload in progress", uploaded: "Verified upload", uncertain: "Outcome unconfirmed", error: "Upload failed" } as const;
export function AttachmentPicker({ files, policy, availability, busy, onAdd, onRemove }: AttachmentPickerProps) {
 const id = useId(), [errors, setErrors] = useState<string[]>([]), [reading, setReading] = useState(false);
 const available = availability.status === "available" && policy !== null;
 return <section aria-label="Brief attachments"><h3>Files and images</h3><label htmlFor={id} className="sr-only">Add input files</label>
  <input id={id} hidden={!available} type="file" multiple accept={policy?.allowedMimeTypes.join(",")} disabled={!available || busy || reading} onChange={async event => {
   const filesToAdd = [...(event.target.files ?? [])]; event.target.value = ""; if (!available || !policy || busy || reading) return;
   const result = validateAttachmentSelection(filesToAdd, files, policy);
   setErrors(result.errors.map(error => `${error.name}: ${error.code === "count" ? "too many files" : error.code === "mime" ? "unsupported file type" : error.code === "total_bytes" ? "combined file size limit exceeded" : "empty or oversized file"}.`));
   if (!result.accepted.length) return;
   setReading(true); try { await onAdd(result.accepted); } catch { setErrors(previous => [...previous, "Some files could not be read. Existing files and prompt are retained."]); } finally { setReading(false); }
  }} />
  {!available && <p className="field-hint" role="status">File attachments are currently unavailable. You can keep writing your prompt.</p>}
  <ContextDetails className="home-attachment-details" title={<>{available ? "How files are used" : "Availability details"}</>}>{!available && <p className="field-hint">{availability.status === "unavailable" ? availability.reason : "Verified attachment storage is unavailable."}</p>}<p className="field-hint">Files stay in this tab until saved to your account. They are retained as input material; no AI reading or upload to a provider is implied.</p></ContextDetails>
  {!!files.length && <ul>{files.map(file => <li key={file.localId}>{file.name} · {file.byteLength.toLocaleString()} bytes · {labels[file.state]} <button className="text-link" type="button" disabled={busy || reading || file.state === "uploading" || file.state === "uncertain"} onClick={() => onRemove(file.localId)}>Remove {file.name}</button></li>)}</ul>}
  {errors.map((error, index) => <p className="form-error" role="alert" key={`${index}:${error}`}>{error}</p>)}
 </section>;
}
