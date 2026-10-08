"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isAssetRetained, type AssetLibraryItem, type AssetLibraryPage, type AssetLibraryQuery, type AssetProjectSummary } from "@/domain/asset-library";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { assetErrorMessage, createAccountAssetsClient } from "./account-assets-client";

export function useAssetLibrary(account: VerifiedAccount) {
  const { isCurrent, expire } = useAccountSession();
  const [client] = useState(() => createAccountAssetsClient(account, isCurrent, expire));
  const [query, setQuery] = useState<AssetLibraryQuery>({ tab: "my_selection", limit: 40 });
  const [page, setPage] = useState<AssetLibraryPage | null>(null);
  const [projects, setProjects] = useState<AssetProjectSummary[]>([]);
  const [facetLimited, setFacetLimited] = useState(false);
  const [facetUnavailable, setFacetUnavailable] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [needsCheck, setNeedsCheck] = useState(false);
  const epoch = useRef(0), sequence = useRef(0), inFlight = useRef(false), read = useRef<AbortController | null>(null);
  useEffect(() => { client.activate(); return () => client.dispose(); }, [client]);
  useEffect(() => {
    const controller = new AbortController();
    void client.projects(controller.signal).then(reply => { if (reply) { setProjects(previous => [...new Map([...previous, ...reply.projects].map(project => [project.id, project])).values()]); setFacetUnavailable(false); setFacetLimited(reply.projects.length === 100); } }).catch(() => { if (!controller.signal.aborted && client.current()) setFacetUnavailable(true); });
    return () => controller.abort();
  }, [client, reload]);
  useEffect(() => {
    const controller = new AbortController(); read.current = controller;
    const observedEpoch = epoch.current, observedSequence = ++sequence.current;
    void client.list(query, controller.signal).then(reply => {
      if (!reply || controller.signal.aborted || observedEpoch !== epoch.current || observedSequence !== sequence.current) return;
      setPage(reply); setStatus("ready"); setError(null); setNeedsCheck(false);
      setProjects(previous => [...new Map([...previous, ...reply.items.map(item => item.project)].map(project => [project.id, project])).values()]);
    }).catch(cause => {
      if (!controller.signal.aborted && client.current() && observedEpoch === epoch.current && observedSequence === sequence.current) { setError(assetErrorMessage(cause)); setStatus("error"); }
    });
    return () => controller.abort();
  }, [client, query, reload]);
  const refresh = useCallback(() => { epoch.current += 1; read.current?.abort(); setStatus("loading"); setError(null); setReload(value => value + 1); }, []);
  function changeQuery(next: Omit<AssetLibraryQuery, "cursor" | "limit">) {
    if (inFlight.current) return;
    epoch.current += 1; sequence.current += 1; read.current?.abort();
    setPage(null); setStatus("loading"); setError(null); setQuery({ ...next, limit: 40 });
  }
  async function retain(item: AssetLibraryItem, field: "liked" | "saved") {
    if (inFlight.current || needsCheck || !client.current()) return;
    inFlight.current = true; epoch.current += 1; read.current?.abort(); setBusy(true); setError(null);
    try {
      const reply = await client.retain(item.asset, { expectedRetentionRevision: item.asset.retentionRevision, liked: item.asset.liked, saved: item.asset.saved, [field]: !item.asset[field] });
      if (!reply) return;
      // A neutral response cannot replace format-specific preview or history metadata.
      setPage(previous => previous ? { ...previous, items: previous.items.map(row => row.asset.id === reply.asset.id ? { ...row, asset: { ...row.asset, liked: reply.asset.liked, saved: reply.asset.saved, retentionRevision: reply.asset.retentionRevision } } : row).filter(row => query.tab !== "my_selection" || isAssetRetained(row.asset)) } : null);
      refresh();
    } catch (cause) { if (client.current()) { setError(assetErrorMessage(cause, "write")); setNeedsCheck(true); setStatus("error"); } }
    finally { inFlight.current = false; if (client.current()) setBusy(false); }
  }
  async function loadMore() {
    if (!page?.nextCursor || status !== "ready" || inFlight.current || !client.current()) return;
    inFlight.current = true; setBusy(true); setError(null);
    const observedEpoch = epoch.current, observedSequence = ++sequence.current;
    try {
      const reply = await client.list({ ...query, cursor: page.nextCursor });
      if (!reply || observedEpoch !== epoch.current || observedSequence !== sequence.current) return;
      setPage(previous => { if (!previous) return null; const existing = new Set(previous.items.map(item => item.asset.id)); return { ...reply, items: [...previous.items, ...reply.items.filter(item => !existing.has(item.asset.id))] }; });
      setProjects(previous => [...new Map([...previous, ...reply.items.map(item => item.project)].map(project => [project.id, project])).values()]);
    } catch (cause) { if (client.current() && observedEpoch === epoch.current) setError(assetErrorMessage(cause)); }
    finally { inFlight.current = false; if (client.current()) setBusy(false); }
  }
  return { client, query, page, projects, facetUnavailable, facetLimited, status, error, busy, needsCheck, changeQuery, refresh, retain, loadMore };
}
