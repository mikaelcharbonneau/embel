"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { accountDraftChanged } from "@/components/workspace/account-draft-memory";
import { emptyVisualGuidance, sameVisualGuidance, visualDirectionGuidanceSchema, type VisualDirectionGuidance, type VisualDirectionOverview } from "@/domain/visual-direction";
import { createVisualDirectionClient, visualDirectionError } from "./visual-direction-client";

function sameBasis(a: VisualDirectionOverview, b: VisualDirectionOverview) {
  return a.current?.id === b.current?.id && a.inspiration.selectionRevision === b.inspiration.selectionRevision && a.inspiration.projectRevision === b.inspiration.projectRevision;
}
export function useVisualDirection(account: VerifiedAccount, projectId: string) {
  const { isCurrent, expire, visualDirectionDrafts: memory, inspirationDrafts, drafts } = useAccountSession();
  const [client] = useState(() => createVisualDirectionClient(account, projectId, isCurrent, expire));
  const draft = useSyncExternalStore(memory.subscribe, () => memory.get(account, projectId), () => null);
  const inspirationIntents = useSyncExternalStore(inspirationDrafts.subscribe, () => inspirationDrafts.get(account, projectId), () => inspirationDrafts.get(account, projectId));
  const projectDraft = useSyncExternalStore(drafts.subscribe, () => drafts.get(projectId), () => null);
  const blocked = inspirationIntents.size > 0 || Boolean(projectDraft && projectDraft.ownerId === account.userId && (projectDraft.conflict || accountDraftChanged(projectDraft)));
  const [overview, setOverview] = useState<VisualDirectionOverview | null>(null), latest = useRef<VisualDirectionOverview | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const reads = useRef(0), writing = useRef(false);
  const accept = useCallback((value: VisualDirectionOverview) => {
    if (!client.current()) return false;
    const old = latest.current;
    if (old && ((value.current?.revision ?? 0) < (old.current?.revision ?? 0) || value.inspiration.selectionRevision < old.inspiration.selectionRevision || value.inspiration.projectRevision < old.inspiration.projectRevision)) return false;
    latest.current = value; setOverview(value); return true;
  }, [client]);
  const refresh = useCallback(async () => {
    if (!client.current() || writing.current) return;
    const sequence = ++reads.current; setLoading(true);
    try {
      const value = await client.read(); if (!value || sequence !== reads.current || !accept(value)) return;
      const pending = memory.get(account, projectId);
      if (pending) {
        if (!value.stale && value.current && sameVisualGuidance(value.current.guidance, pending.guidance) &&
          value.current.projectRevision === pending.base.inspiration.projectRevision && value.current.selectionRevision === pending.base.inspiration.selectionRevision) {
          memory.put(account, projectId, null); setMessage("Your saved visual direction is confirmed.");
        } else memory.put(account, projectId, { ...pending, mustReload: false, latest: sameBasis(pending.base, value) ? null : value });
      }
      setError(null);
    } catch (cause) { if (client.current() && sequence === reads.current) setError(visualDirectionError(cause)); }
    finally { if (client.current() && sequence === reads.current) setLoading(false); }
  }, [account, projectId, client, accept, memory]);
  useEffect(() => {
    client.activate(); let mounted = true;
    queueMicrotask(() => { if (mounted) void refresh(); });
    return () => { mounted = false; client.dispose(); };
  }, [client, refresh]);
  const guidance = draft?.guidance ?? overview?.current?.guidance ?? emptyVisualGuidance();
  function edit(values: VisualDirectionGuidance) {
    const base = draft?.base ?? latest.current;
    if (!client.current() || writing.current || !base) return;
    // Form edits retain raw bounded text; the save schema trims/validates it.
    if (Object.values(values).some(value => value.length > 1200)) return;
    if (!draft?.mustReload && !draft?.latest && sameVisualGuidance(values, base.current?.guidance ?? emptyVisualGuidance())) memory.put(account, projectId, null);
    else memory.put(account, projectId, { base, guidance: values, latest: draft?.latest ?? null, mustReload: draft?.mustReload ?? false });
    setMessage(null);
  }
  const parsed = visualDirectionGuidanceSchema.safeParse(guidance);
  const hasContent = Boolean(parsed.success && (Object.values(parsed.data).some(Boolean) || overview?.inspiration.choices.some(choice => choice.ensemble || choice.elements.length)));
  const canSave = client.current() && !!overview && !loading && !saving && !error && !blocked && !draft?.mustReload && !draft?.latest && overview.inspiration.projectScope !== "naming_only" && hasContent &&
    (!overview.current || overview.stale || !sameVisualGuidance(guidance, overview.current.guidance));
  async function save() {
    const base = latest.current;
    if (!canSave || !base || !parsed.success || writing.current) return;
    const input = { expectedRevision: base.current?.revision ?? 0, expectedProjectRevision: base.inspiration.projectRevision,
      expectedSelectionRevision: base.inspiration.selectionRevision, catalogVersion: base.inspiration.catalogVersion, guidance: parsed.data };
    writing.current = true; reads.current++; setSaving(true); setMessage(null);
    memory.put(account, projectId, { base, guidance: parsed.data, latest: null, mustReload: true });
    try {
      const value = await client.save(input); if (!value || !client.current()) return;
      if (!value.current || value.stale || value.current.revision !== input.expectedRevision + 1 || value.current.projectRevision !== input.expectedProjectRevision ||
        value.current.selectionRevision !== input.expectedSelectionRevision || !sameVisualGuidance(value.current.guidance, input.guidance)) throw new Error("Unconfirmed review receipt");
      if (accept(value)) { memory.put(account, projectId, null); setError(null); setMessage("Visual direction reviewed and saved. Generation still needs a separate estimate and confirmation."); return true; }
    } catch (cause) { if (client.current()) setError(visualDirectionError(cause)); }
    finally { writing.current = false; if (client.current()) setSaving(false); }
  }
  function resolve(keepMine: boolean) {
    if (!client.current() || writing.current || !draft?.latest) return;
    if (keepMine) memory.put(account, projectId, { base: draft.latest, guidance: draft.guidance, latest: null, mustReload: false });
    else memory.put(account, projectId, null);
    setError(null); setMessage(null);
  }
  return { overview: client.current() ? overview : null, guidance: client.current() ? guidance : emptyVisualGuidance(), draft: client.current() ? draft : null,
    loading, saving, blocked, error: client.current() ? error : null, message: client.current() ? message : null, canSave, edit, save, refresh,
    keepMine: () => resolve(true), useLatest: () => resolve(false),
    discard() { if (client.current() && !writing.current && !draft?.mustReload) { memory.put(account, projectId, null); setMessage(null); } } };
}
