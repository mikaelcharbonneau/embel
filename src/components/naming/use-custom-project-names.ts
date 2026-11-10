"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { projectNamePageSchema, type NamingCursor, type ProjectNameEntry } from "@/domain/project-naming";
import { createNamingRequestScope, namingErrorMessage, namingOwned } from "./use-project-naming";

/** Imports remain reachable independently of generated feed pages and runtime readiness. */
export function useCustomProjectNames(account: VerifiedAccount, projectId: string) {
  const { isCurrent, expire } = useAccountSession();
  const [scope] = useState(() => createNamingRequestScope(account, isCurrent, expire));
  const [items, setItems] = useState<ProjectNameEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<NamingCursor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false),
    depth = useRef(0),
    sequence = useRef(0),
    refreshQueued = useRef(false);
  // Keep verified save receipts ahead of reads that began before the mutation.
  // A later server page, rather than a local render, acknowledges catching up.
  const acknowledged = useRef(new Map<string, ProjectNameEntry>());
  const reconcile = useCallback((entries: ProjectNameEntry[], observed = false) => {
    const merged = new Map(entries.map((entry) => [entry.candidate.id, entry]));
    for (const [id, entry] of acknowledged.current) {
      const read = merged.get(id);
      if (read && read.retention.revision >= entry.retention.revision) {
        if (observed) acknowledged.current.delete(id);
      } else merged.set(id, entry);
    }
    return [...merged.values()];
  }, []);
  function acknowledge(entry: ProjectNameEntry) {
    if (
      !scope.current() ||
      !namingOwned(entry.candidate, account.userId, projectId) ||
      entry.candidate.origin.kind !== "local_import"
    )
      return;
    const previous = acknowledged.current.get(entry.candidate.id);
    if (previous && previous.retention.revision > entry.retention.revision) return;
    acknowledged.current.set(entry.candidate.id, entry);
    setItems((items) => reconcile(items.filter((row) => row.candidate.id !== entry.candidate.id)));
  }
  const read = useCallback(
    async (cursor?: NamingCursor) => {
      const params = new URLSearchParams({ limit: "100" });
      if (cursor) {
        params.set("cursorId", cursor.id);
        params.set("cursorCreatedAt", cursor.createdAt);
      }
      return scope.request(
        `/api/projects/${projectId}/naming/custom?${params}`,
        projectNamePageSchema,
        (page) =>
          namingOwned(page, account.userId, projectId) &&
          page.items.every((row) => row.candidate.origin.kind === "local_import"),
      );
    },
    [scope, account.userId, projectId],
  );
  const refresh = useCallback(
    async function refreshCustomNames() {
      if (!scope.current()) return;
      if (busy.current) {
        refreshQueued.current = true;
        return;
      }
      refreshQueued.current = false;
      busy.current = true;
      const request = ++sequence.current;
      try {
        let page = await read();
        if (!page || !scope.current() || request !== sequence.current) return;
        const entries = [...page.items];
        for (
          let index = 1;
          page.nextCursor && entries.length < depth.current && index < Math.ceil(depth.current / 100);
          index++
        ) {
          page = await read(page.nextCursor);
          if (!page || !scope.current() || request !== sequence.current) return;
          entries.push(...page.items);
        }
        depth.current = entries.length;
        setItems(reconcile(entries, true));
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (failure) {
        if (scope.current()) setError(namingErrorMessage(failure));
      } finally {
        busy.current = false;
        if (refreshQueued.current && scope.current()) void refreshCustomNames();
      }
    },
    [read, scope, reconcile],
  );
  useEffect(() => {
    scope.activate();
    void Promise.resolve().then(refresh);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    return () => {
      clearInterval(timer);
      scope.dispose();
    };
  }, [scope, refresh]);
  async function loadMore() {
    if (!nextCursor || busy.current || !scope.current()) return;
    busy.current = true;
    setPending(true);
    try {
      const page = await read(nextCursor);
      if (!page || !scope.current()) return;
      setItems((previous) => {
        const ids = new Set(previous.map((row) => row.candidate.id));
        const next = reconcile([...previous, ...page.items.filter((row) => !ids.has(row.candidate.id))]);
        depth.current = next.length;
        return next;
      });
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (failure) {
      if (scope.current()) setError(namingErrorMessage(failure));
    } finally {
      busy.current = false;
      if (scope.current()) {
        setPending(false);
        if (refreshQueued.current) void refresh();
      }
    }
  }
  return { items, nextCursor, error, pending, refresh, loadMore, acknowledge };
}
