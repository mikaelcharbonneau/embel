"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_NAMES_BYTES, NAMES_STORAGE_KEY, readNamesBackup, type NamesSnapshot } from "./local-names";
import { useNamesActions } from "./use-names-store";

export function NamesBackupImport({ snapshot }: { snapshot: NamesSnapshot }) {
  const namesStore = useNamesActions();
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
    } catch { if (sequence.current === request) setMessage("Choose a valid Embel Names JSON backup of at most 4 MB. Your workspace is unchanged."); }
    finally { if (sequence.current === request) setReading(false); }
  }
  function readBrowserBackup() {
    sequence.current++; setBackup(null); setMessage("");
    try {
      const raw = window.localStorage.getItem(NAMES_STORAGE_KEY);
      if (!raw) { setMessage("No earlier Names backup was found in this browser."); return; }
      const data = readNamesBackup(raw);
      setBackup({ raw, workspace: snapshot.data, names: data.candidates.length, runs: data.runs.length });
    } catch { setMessage("The earlier browser backup could not be read. Its stored data has been left untouched."); }
  }
  const unavailable = snapshot.storage !== "available" || snapshot.dirty || reading;
  return <div className="names-backup-import">
    <input ref={input} type="file" accept="application/json,.json" hidden aria-label="Names backup file" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ""; if (file) void read(file);
    }} />
    <button type="button" className="button secondary small" disabled={unavailable} onClick={() => input.current?.click()}>{reading ? "Reading backup…" : "Import a backup file"}</button>
    <button type="button" className="text-link" disabled={unavailable} onClick={readBrowserBackup}>Recover earlier browser names</button>
    {backup && <div className="names-recovery-confirm" role="alert">
      <p>This backup contains {backup.names} {backup.names === 1 ? "name" : "names"} and {backup.runs} {backup.runs === 1 ? "run" : "runs"}. Import it into the account you are signed in to? Existing names and history are kept. The original backup stays unchanged.</p>
      <button type="button" className="button secondary small" onClick={() => setBackup(null)}>Cancel import</button>
      <button type="button" className="button primary small" disabled={unavailable || backup.workspace !== snapshot.data} onClick={() => {
        const result = namesStore.importBackup(backup.raw, backup.workspace);
        setMessage(result.ok ? "Backup added. The save status above confirms when it reaches your account." : result.error ?? "The backup could not be imported.");
        setBackup(null);
      }}>Import into my account</button>
      {backup.workspace !== snapshot.data && <p>Your names changed. Choose the backup again to review the import.</p>}
    </div>}
    {message && <p role="status">{message}</p>}
  </div>;
}
