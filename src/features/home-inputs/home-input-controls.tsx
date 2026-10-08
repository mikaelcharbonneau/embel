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
export type HomeInputControlsProps = { account: VerifiedAccount | null; sessionFence: string; memory: HomeInputSession; value: string; onChange(value: string): void; language: string; voiceAdapter: HomeVoiceAdapter; policy: AttachmentPolicy | null; availability: HomeAttachmentAvailability; disabled: boolean };
const empty = () => null;
export function HomeInputControls({ account, sessionFence, memory, value, onChange, language, voiceAdapter, policy, availability, disabled }: HomeInputControlsProps) {
 const [pickerRevision, setPickerRevision] = useState(0);
 const read = useCallback(() => account ? memory.get(account) : null, [memory, account]);
 const intent = useSyncExternalStore(memory.subscribe, read, empty);
 const readSelection = useCallback(() => account ? memory.getSelection(account) : null, [memory, account]);
 const selection = useSyncExternalStore(memory.subscribe, readSelection, empty);
 const files: DraftAttachment[] = intent?.files.map(file => ({ localId: file.localId, name: file.file.name, mimeType: file.upload.mimeType, byteLength: file.file.size, state: file.outcome === "verified" ? "uploaded" : file.outcome === "pending" ? "uploading" : file.outcome === "failed" ? "error" : file.outcome, ownedRef: file.receipt })) ?? [];
 const selecting = useSyncExternalStore(memory.subscribe, memory.isSelecting, () => false);
 const busy = selecting || disabled || !!intent?.saveIntent || files.some(file => file.state === "uploading" || file.state === "uncertain");
 async function add(selected: readonly File[]) {
  if (!account || !memory.isCurrent(account) || !policy || availability.status !== "available" || busy) return;
  const old = memory.get(account) ?? emptyHomeInputIntent();
  const checked = validateAttachmentSelection(selected, files, policy); if (checked.errors.length) throw new Error("Attachment bounds changed");
  const reader = memory.beginSelection(account, checked.accepted.length); if (!reader) return;
  try {
  let next = old;
  for (const file of checked.accepted) {
   const data = await file.arrayBuffer(); if (!reader.current()) return;
   const digest = await crypto.subtle.digest("SHA-256", data); if (!reader.current()) return;
   const upload = { requestKey: crypto.randomUUID(), name: file.name, mimeType: attachmentMimeTypeSchema.parse(file.type), contentHash: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("") };
   next = { ...next, files: [...next.files, { localId: crypto.randomUUID(), file, upload, receipt: null, outcome: "local" }] };
   if (!memory.set(account, next)) return;
  }
  reader.complete();
  } finally { reader.interrupt(); }
 }
 return <div className="home-input-controls">
  <details className="home-input-popover home-voice-popover"><summary aria-label="Voice input" title="Voice input"><Icon name="mic" size={20} /></summary><div className="home-input-popover-panel"><HomeVoiceControl key={sessionFence} value={value} onChange={onChange} language={language} sessionFence={sessionFence} adapter={voiceAdapter} disabled={disabled || !!intent?.saveIntent} /></div></details>
  {intent?.saveOutcome === "confirmed" && <p role="status">These files were saved with your brand. <button className="text-link" type="button" disabled={disabled} onClick={() => { if (account) memory.set(account, emptyHomeInputIntent()); }}>Start a new attached brief</button></p>}
  {selection && <div role="status"><p>{selection.status === "interrupted" ? "File selection was interrupted. Ready files are kept. Cancel the pending selection, then choose any remaining files again." : `Reading ${selection.fileCount} selected ${selection.fileCount === 1 ? "file" : "files"}…`}</p><button className="text-link" type="button" disabled={disabled} onClick={() => { if (account && memory.cancelSelection(account, selection.id)) setPickerRevision(value => value + 1); }}>Cancel pending file selection</button></div>}
  <details className="home-input-popover home-files-popover"><summary><Icon name="plus" size={20} /><span>Add files or images</span></summary><div className="home-input-popover-panel"><AttachmentPicker key={`${sessionFence}:${pickerRevision}`} files={files} policy={policy} availability={account ? availability : { status: "unavailable", reason: "Sign in to save verified input files. Your typed prompt stays available." }} busy={busy} onAdd={add} onRemove={localId => { if (!account || busy) return; const current = memory.get(account); if (current) memory.set(account, { ...current, files: current.files.filter(file => file.localId !== localId) }); }} /></div></details>
 </div>;
}
