"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isAssetRetained, type AssetLibraryItem, type AssetLibraryPage, type AssetLibraryQuery, type AssetProjectSummary } from "@/domain/asset-library";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { AssetWriteOutcomeUnknownError, assetErrorMessage, createAccountAssetsClient } from "./account-assets-client";
import { appendAssetLibraryPage, AssetLibraryWindowChangedError, readAssetLibraryWindow } from "./asset-library-window";

export function useAssetLibrary(account: VerifiedAccount) {
  const { isCurrent, expire } = useAccountSession();
  const [client] = useState(() => createAccountAssetsClient(account, isCurrent, expire));
  const [query, setQuery] = useState<AssetLibraryQuery>({ tab: "my_selection", limit: 40 });
  const requestedQuery = useRef(query);
  const [page, setPage] = useState<AssetLibraryPage | null>(null);
  const [projects, setProjects] = useState<AssetProjectSummary[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [needsCheck, setNeedsCheck] = useState(false);
  const epoch = useRef(0), sequence = useRef(0), read = useRef<AbortController | null>(null);
  const loaded = useRef<AssetLibraryPage | null>(null);
  const operation = useRef<{ kind: "retain" | "more" } | null>(null);
  useEffect(() => { client.activate(); return () => client.dispose(); }, [client]);
  useEffect(() => {
    const controller = new AbortController();
    // Projects named by loaded assets already carry their chosen brand name; keep it.
    // A failed project list leaves the filter with the projects of loaded assets.
    void client.projects(controller.signal).then(reply => { if (reply && !controller.signal.aborted && client.current()) setProjects(previous => [...new Map([...reply.projects, ...previous].map(project => [project.id, project])).values()]); }).catch(() => undefined);
    return () => controller.abort();
  }, [client, reload]);
  useEffect(() => {
    const controller = new AbortController(); read.current = controller;
    const observedEpoch = epoch.current, observedSequence = ++sequence.current;
    void (async () => {
      if (typeof client.reconcileWrites === "function" && !await client.reconcileWrites(controller.signal)) {
        if (controller.signal.aborted || !client.current()) return null;
        // Another asset can become uncertain while the captured recovery reads
        // are pending. Keep its fence and expose recovery instead of spinning.
        throw new AssetWriteOutcomeUnknownError();
      }
      return readAssetLibraryWindow(client, query, loaded.current, controller.signal);
    })().then(reply => {
      if (!reply || !client.current() || controller.signal.aborted || observedEpoch !== epoch.current || observedSequence !== sequence.current) return;
      loaded.current = reply;
      setPage(reply); setStatus("ready"); setError(null); setNeedsCheck(false);
      setProjects(previous => [...new Map([...previous, ...reply.items.map(item => item.project)].map(project => [project.id, project])).values()]);
    }).catch(cause => {
      if (!controller.signal.aborted && client.current() && observedEpoch === epoch.current && observedSequence === sequence.current) {
        setError(cause instanceof AssetLibraryWindowChangedError ? "The asset list changed too much to finish checking. Your previously loaded view is still shown. Try again, or change a filter to start a new view." : `${assetErrorMessage(cause)}${loaded.current ? " Previously loaded assets are still shown." : ""}`);
        setStatus("error");
      }
    });
    return () => controller.abort();
  }, [client, query, reload]);
  const refresh = useCallback(() => {
    // A read cannot establish the outcome of an outstanding write. Its own
    // acknowledgment (or explicit recovery after failure) starts reconciliation.
    if (operation.current?.kind === "retain") return;
    epoch.current += 1; sequence.current += 1; read.current?.abort();
    operation.current = null; setBusy(false); setStatus("loading"); setError(null); setReload(value => value + 1);
  }, []);
  function changeQuery(next: Omit<AssetLibraryQuery, "cursor" | "limit">) {
    if (operation.current) return;
    const current = requestedQuery.current;
    if (current.tab === next.tab && current.projectId === next.projectId && current.format === next.format) return;
    // Track the requested filter synchronously: several changes can arrive
    // before React commits, and A → B → A must still issue the final A read.
    const updated = { tab: next.tab, projectId: next.projectId, format: next.format, limit: 40 };
    requestedQuery.current = updated;
    epoch.current += 1; sequence.current += 1; read.current?.abort();
    loaded.current = null;
    setPage(null); setStatus("loading"); setError(null); setQuery(updated);
  }
  async function retain(item: AssetLibraryItem, field: "liked" | "saved") {
    const activePage = loaded.current;
    if (operation.current || needsCheck || !client.current() || !activePage?.items.some(row => row.asset.id === item.asset.id && row.asset.projectId === item.asset.projectId)) return;
    const pending = { kind: "retain" as const };
    operation.current = pending; epoch.current += 1; sequence.current += 1; read.current?.abort(); setBusy(true); setError(null);
    try {
      const reply = await client.retain(item.asset, { expectedRetentionRevision: item.asset.retentionRevision, liked: item.asset.liked, saved: item.asset.saved, [field]: !item.asset[field] });
      if (!reply || !client.current()) return;
      // A neutral response cannot replace format-specific preview or history metadata.
      // Keep the original loaded boundary until reconciliation, even when this
      // acknowledged change removes the oldest visible card from My selection.
      setPage(previous => previous ? { ...previous, items: previous.items.map(row => row.asset.id === reply.asset.id ? { ...row, asset: { ...row.asset, liked: reply.asset.liked, saved: reply.asset.saved, retentionRevision: reply.asset.retentionRevision } } : row).filter(row => activePage.query.tab !== "my_selection" || isAssetRetained(row.asset)) } : null);
      operation.current = null;
      refresh();
    } catch (cause) { if (client.current()) { setError(assetErrorMessage(cause, "write")); setNeedsCheck(true); setStatus("error"); } }
    finally { if (operation.current === pending) { operation.current = null; if (client.current()) setBusy(false); } }
  }
  async function loadMore() {
    if (!loaded.current?.nextCursor || status !== "ready" || operation.current || !client.current()) return;
    const pending = { kind: "more" as const }, previous = loaded.current;
    const controller = new AbortController(); read.current = controller;
    operation.current = pending; setBusy(true); setError(null);
    const observedEpoch = epoch.current, observedSequence = ++sequence.current;
    try {
      const reply = await client.list({ ...previous.query, cursor: previous.nextCursor! }, controller.signal);
      if (!reply || !client.current() || controller.signal.aborted || observedEpoch !== epoch.current || observedSequence !== sequence.current) return;
      const combined = appendAssetLibraryPage(previous, reply);
      loaded.current = combined; setPage(combined);
      setProjects(previous => [...new Map([...previous, ...reply.items.map(item => item.project)].map(project => [project.id, project])).values()]);
    } catch (cause) { if (!controller.signal.aborted && client.current() && observedEpoch === epoch.current && observedSequence === sequence.current) setError(assetErrorMessage(cause)); }
    finally { if (operation.current === pending) { operation.current = null; if (client.current()) setBusy(false); } }
  }
  return { client, query, page, projects, status, error, busy, needsCheck, changeQuery, refresh, retain, loadMore };
}
