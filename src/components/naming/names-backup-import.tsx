"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_NAMES_BYTES, readNamesBackup, type NamesSnapshot } from "./local-names";
import { namesStore } from "./use-names-store";

export function NamesBackupImport({ snapshot }: { snapshot: NamesSnapshot }) {
  const input = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const [backup, setBackup] = useState<{ raw: string; workspace: NamesSnapshot["data"]; names: number; runs: number } | null>(null);
  const [message, setMessage] = useState("");
  const [reading, setReading] = useState(false);
  useEffect(() => () => { sequence.current++; }, []);
  async function read(file: File) {
    const request = ++sequence.current, workspace = snapshot.data;
    setBackup(null); setMessage(""); setReading(true);
    try {
      if (file.size > MAX_NAMES_BYTES) throw new Error();
      const raw = await file.text();
      if (sequence.current !== request) return;
      const data = readNamesBackup(raw);
      setBackup({ raw, workspace, names: data.candidates.length, runs: data.runs.length });
    } catch { if (sequence.current === request) setMessage("Choose a valid Fluid Names JSON backup of at most 4 MB. Your workspace is unchanged."); }
    finally { if (sequence.current === request) setReading(false); }
  }
  const unavailable = snapshot.storage !== "available" || snapshot.dirty || reading;
  return <div className="names-backup-import">
    <input ref={input} type="file" accept="application/json,.json" hidden aria-label="Names backup file" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ""; if (file) void read(file);
    }} />
    <button type="button" className="button secondary small" disabled={unavailable} onClick={() => input.current?.click()}>{reading ? "Reading backup…" : "Restore workspace copy"}</button>
    {backup && <div className="names-recovery-confirm" role="alert">
      <p>This backup contains {backup.names} {backup.names === 1 ? "name" : "names"} and {backup.runs} {backup.runs === 1 ? "run" : "runs"}. Restoring it replaces the {snapshot.data.candidates.length} names and {snapshot.data.runs.length} runs in this browser. Download your current workspace first if you want to keep it.</p>
      <button type="button" className="button secondary small" onClick={() => setBackup(null)}>Keep current workspace</button>
      <button type="button" className="button danger small" disabled={unavailable || backup.workspace !== snapshot.data} onClick={() => {
        const result = namesStore.restoreBackup(backup.raw, backup.workspace);
        setMessage(result.ok && result.persisted ? "Names workspace restored in this browser." : result.error ?? "The backup could not be restored.");
        setBackup(null);
      }}>Replace workspace with backup</button>
      {backup.workspace !== snapshot.data && <p>Your workspace changed. Choose the backup again to review replacement.</p>}
    </div>}
    {message && <p role="status">{message}</p>}
  </div>;
}
