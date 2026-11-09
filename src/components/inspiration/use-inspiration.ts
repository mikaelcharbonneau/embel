"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { INSPIRATION_CATALOG_VERSION, sameInspirationChoice, type InspirationOverview, type InspirationPreferences } from "@/domain/inspiration";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { accountDraftChanged } from "@/components/workspace/account-draft-memory";
import { createInspirationClient, inspirationError } from "./inspiration-client";

export function useInspiration(account: VerifiedAccount, projectId: string) {
  const { isCurrent, expire, drafts, inspirationDrafts } = useAccountSession();
  const [client] = useState(() => createInspirationClient(account, projectId, isCurrent, expire));
  const intents = useSyncExternalStore(inspirationDrafts.subscribe, () => inspirationDrafts.get(account, projectId), () => inspirationDrafts.get(account, projectId));
  const draft = useSyncExternalStore(drafts.subscribe, () => drafts.get(projectId), () => null);
  const blocked = Boolean(draft && draft.ownerId === account.userId && (draft.conflict || accountDraftChanged(draft)));
  const [overview, setOverview] = useState<InspirationOverview | null>(null), [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(new Set<string>());
  const latest = useRef<InspirationOverview | null>(null), inFlight = useRef(new Set<string>()), reads = useRef(0);
  const accept = useCallback((value: InspirationOverview) => {
    if (!client.current() || latest.current && value.selectionRevision < latest.current.selectionRevision) return false;
    if (latest.current && value.projectRevision < latest.current.projectRevision) return false;
    latest.current = value; setOverview(value); return true;
  }, [client]);
  const load = useCallback(async () => {
    const sequence = ++reads.current;
    try { const value = await client.read(); if (value && sequence === reads.current && accept(value)) setError(null); }
    catch (cause) { if (client.current() && sequence === reads.current) setError(inspirationError(cause)); }
    finally { if (client.current() && sequence === reads.current) setLoading(false); }
  }, [client, accept]);
  useEffect(() => {
    client.activate();
    // Defer initial I/O until the mount settles; Strict Mode cleanup cancels it.
    let mounted = true;
    queueMicrotask(() => { if (mounted) void load(); });
    return () => { mounted = false; client.dispose(); };
  }, [client, load]);
  const refresh = async () => { setLoading(true); await load(); };
  const canSave = Boolean(overview && !blocked && !error && !loading);
  async function save(id: string, { ensemble, elements }: InspirationPreferences, retry = false) {
    // Saved reactions also contain owner/project metadata. Only editable fields
    // may enter intent memory or the strict mutation payload.
    const desired: InspirationPreferences = { ensemble, elements: [...elements] };
    const current = latest.current;
    if (!current || !client.current() || !canSave || inFlight.current.has(id) || (!retry && intents.has(id))) return;
    const old = current.choices.find(choice => choice.referenceId === id);
    const pending = inspirationDrafts.get(account, projectId).get(id);
    if (retry && (!pending?.checked || pending.expectedRevision !== (old?.revision ?? 0) || pending.expectedProjectRevision !== current.projectRevision)) return;
    if (sameInspirationChoice(old ?? { ensemble: false, elements: [] }, desired)) { inspirationDrafts.put(account, projectId, id, null); return; }
    const intent = { desired, expectedRevision: old?.revision ?? 0, expectedProjectRevision: current.projectRevision, checked: false, error: "Your changes have not been confirmed yet." };
    inspirationDrafts.put(account, projectId, id, intent); inFlight.current.add(id); setBusy(new Set(inFlight.current));
    try {
      const value = await client.save(id, { ...desired, expectedRevision: intent.expectedRevision, expectedProjectRevision: current.projectRevision, catalogVersion: INSPIRATION_CATALOG_VERSION });
      if (!value || !client.current()) return;
      const saved = value.choices.find(choice => choice.referenceId === id);
      if (!saved || saved.revision !== intent.expectedRevision + 1 || !sameInspirationChoice(saved, desired)) throw new Error("Unconfirmed choice");
      accept(value); inspirationDrafts.put(account, projectId, id, null);
    } catch (cause) { if (client.current()) inspirationDrafts.put(account, projectId, id, { ...intent, checked: false, error: inspirationError(cause) }); }
    finally { inFlight.current.delete(id); if (client.current()) setBusy(new Set(inFlight.current)); }
  }
  async function check(id: string) {
    const intent = inspirationDrafts.get(account, projectId).get(id);
    if (!intent || inFlight.current.has(id)) return;
    inFlight.current.add(id); setBusy(new Set(inFlight.current));
    try {
      const value = await client.read(); if (!value || !client.current()) return;
      accept(value);
      const saved = latest.current?.choices.find(choice => choice.referenceId === id);
      if (sameInspirationChoice(saved ?? { ensemble: false, elements: [] }, intent.desired)) inspirationDrafts.put(account, projectId, id, null);
      else inspirationDrafts.put(account, projectId, id, { ...intent, expectedRevision: saved?.revision ?? 0, expectedProjectRevision: latest.current!.projectRevision, checked: true, error: "Saved choices checked. You can keep them or save your pending changes." });
      setError(null);
    } catch (cause) { if (client.current()) inspirationDrafts.put(account, projectId, id, { ...intent, checked: false, error: inspirationError(cause) }); }
    finally { inFlight.current.delete(id); if (client.current()) setBusy(new Set(inFlight.current)); }
  }
  return { overview, intents, busy, loading, blocked, error, canSave, refresh, save, check,
    keepSaved: (id: string) => { if (!inFlight.current.has(id)) inspirationDrafts.put(account, projectId, id, null); } };
}
export type InspirationController = ReturnType<typeof useInspiration>;
