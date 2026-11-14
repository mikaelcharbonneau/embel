"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AccountProject } from "@/domain/project-api";
import {
  identityReferenceQuerySchema,
  setReferenceReactionSchema,
  type IdentityReferenceEntry,
  type IdentityReferenceQuery,
  type IdentityReferencesOverview,
  type SetReferenceReactionResponse,
} from "@/domain/identity-references";
import { accountDraftChanged } from "@/components/workspace/account-draft-memory";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { createAccountReferenceClient, referenceErrorMessage } from "./account-reference-client";

export type ReferenceChoices = Pick<IdentityReferenceEntry["reaction"], "ensemble" | "elements">;
export type ReferenceIntent = {
  entry: IdentityReferenceEntry;
  query: IdentityReferenceQuery;
  choices: ReferenceChoices;
  phase: "unconfirmed" | "conflict";
  error: string;
};
/** Survives same-owner session rechecks only in this mounted page. Never browser storage. */
export function createReferenceIntentMemory() {
  let owner: string | null = null;
  const projects = new Map<string, Map<string, ReferenceIntent>>();
  return {
    clear() {
      owner = null;
      projects.clear();
    },
    bind(ownerId: string) {
      if (owner !== ownerId) {
        owner = ownerId;
        projects.clear();
      }
    },
    get(ownerId: string, projectId: string) {
      return owner === ownerId ? new Map(projects.get(projectId)) : new Map<string, ReferenceIntent>();
    },
    put(ownerId: string, projectId: string, items: Map<string, ReferenceIntent>) {
      if (owner === ownerId) projects.set(projectId, new Map(items));
    },
  };
}
export type ReferenceIntentMemory = ReturnType<typeof createReferenceIntentMemory>;
const equalChoices = (left: ReferenceChoices, right: ReferenceChoices) =>
  left.ensemble === right.ensemble && JSON.stringify(left.elements) === JSON.stringify(right.elements);

/** Concurrent per-reference receipts cannot lower aggregate counts or row revisions. */
export function applyReferenceReceipt(
  page: IdentityReferencesOverview,
  receipt: SetReferenceReactionResponse,
): IdentityReferencesOverview {
  if (page.ownerId !== receipt.ownerId || page.projectId !== receipt.projectId)
    throw new Error("Reference scope mismatch");
  return {
    ...page,
    ...(receipt.referenceRevision >= page.referenceRevision
      ? { referenceRevision: receipt.referenceRevision, selectedReferenceCount: receipt.selectedReferenceCount }
      : {}),
    references: {
      ...page.references,
      items: page.references.items.map((entry) =>
        entry.reference.id === receipt.entry.reference.id && entry.reaction.revision <= receipt.entry.reaction.revision
          ? receipt.entry
          : entry,
      ),
    },
  };
}
export function useIdentityReferences(account: VerifiedAccount, projectId: string, memory: ReferenceIntentMemory) {
  const { isCurrent, expire, drafts } = useAccountSession();
  const [client] = useState(() => createAccountReferenceClient(account, projectId, isCurrent, expire));
  const draft = useSyncExternalStore(
    drafts.subscribe,
    () => drafts.get(projectId),
    () => null,
  );
  const blocked = !!draft && draft.ownerId === account.userId && (draft.conflict || accountDraftChanged(draft));
  const [project, setProject] = useState<AccountProject | null>(null);
  const [page, setPage] = useState<IdentityReferencesOverview | null>(null);
  const [filterMetadata, setFilterMetadata] = useState<Pick<
    IdentityReferencesOverview,
    "availableTags" | "tagsComplete" | "referenceRevision" | "selectedReferenceCount"
  > | null>(null);
  const [query, setQuery] = useState<IdentityReferenceQuery>({ limit: 40, excludedTags: [] });
  const requestedQuery = useRef(query);
  const [error, setError] = useState<string | null>(null),
    [projectError, setProjectError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true),
    [loadingMore, setLoadingMore] = useState(false);
  const [reload, setReload] = useState(0),
    [projectReload, setProjectReload] = useState(0);
  const [intents, setIntents] = useState(() => memory.get(account.userId, projectId));
  const [pending, setPending] = useState(new Set<string>());
  const currentIntents = useRef(intents),
    mutations = useRef(new Set<string>()),
    latestRevision = useRef(0);
  const sequence = useRef(0),
    epoch = useRef(0),
    controller = useRef<AbortController | null>(null),
    morePending = useRef(false),
    refreshNeeded = useRef(false);
  const pageQueries = useRef<IdentityReferenceQuery[]>([query]),
    entryQueries = useRef(new Map<string, IdentityReferenceQuery>());
  const eligible = project !== null && !blocked;
  useEffect(() => {
    client.activate();
    return () => client.dispose();
  }, [client]);
  useEffect(() => {
    const pending = new AbortController();
    void client
      .getProject(pending.signal)
      .then((reply) => {
        if (reply) {
          setProject(reply.project);
          setProjectError(null);
        }
      })
      .catch((cause) => {
        if (!pending.signal.aborted && client.current()) setProjectError(referenceErrorMessage(cause));
      });
    return () => pending.abort();
  }, [client, projectReload]);
  const refresh = useCallback(() => {
    epoch.current += 1;
    controller.current?.abort();
    setLoading(true);
    setError(null);
    setReload((value) => value + 1);
  }, []);
  useEffect(() => {
    if (!eligible) return;
    const read = new AbortController();
    controller.current = read;
    const observedEpoch = epoch.current,
      observedSequence = ++sequence.current;
    // Rebuild a contiguous prefix from fresh returned cursors. Replaying previous
    // page cursors would leave gaps when references are inserted before page one.
    const wantedPages = pageQueries.current.length;
    void (async () => {
      const replies: IdentityReferencesOverview[] = [];
      let input = identityReferenceQuerySchema.parse({ limit: query.limit, excludedTags: query.excludedTags });
      for (let index = 0; index < wantedPages; index++) {
        const reply = await client.list(input, read.signal);
        if (!reply || read.signal.aborted || observedEpoch !== epoch.current || observedSequence !== sequence.current)
          return null;
        replies.push(reply);
        if (!reply.references.nextCursor) break;
        input = identityReferenceQuerySchema.parse({ ...input, cursor: reply.references.nextCursor });
      }
      return replies;
    })()
      .then((pages) => {
        if (!pages || read.signal.aborted || observedEpoch !== epoch.current || observedSequence !== sequence.current)
          return;
        const first = pages[0]!;
        if (
          first.referenceRevision < latestRevision.current ||
          pages.some(
            (part) =>
              part.referenceRevision !== first.referenceRevision ||
              part.selectedReferenceCount !== first.selectedReferenceCount,
          )
        )
          throw new Error("Changed reference pages");
        pageQueries.current = pages.map((part) => part.query);
        const entries = new Map<string, IdentityReferenceEntry>();
        entryQueries.current.clear();
        pages.forEach((part) =>
          part.references.items.forEach((entry) => {
            entries.set(entry.reference.id, entry);
            entryQueries.current.set(entry.reference.id, part.query);
          }),
        );
        const availableTags = [...new Set(pages.flatMap((part) => part.availableTags))];
        const loaded = {
          ...first,
          availableTags,
          tagsComplete: pages.every((part) => part.tagsComplete),
          references: { items: [...entries.values()], nextCursor: pages.at(-1)!.references.nextCursor },
        };
        setPage(loaded);
        setFilterMetadata({
          availableTags,
          tagsComplete: loaded.tagsComplete,
          referenceRevision: first.referenceRevision,
          selectedReferenceCount: first.selectedReferenceCount,
        });
        latestRevision.current = first.referenceRevision;
        setLoading(false);
        setError(null);
      })
      .catch((cause) => {
        if (
          !read.signal.aborted &&
          client.current() &&
          observedEpoch === epoch.current &&
          observedSequence === sequence.current
        ) {
          setError(referenceErrorMessage(cause));
          setLoading(false);
        }
      });
    return () => read.abort();
  }, [client, eligible, query, reload]);
  function publishIntents(next: Map<string, ReferenceIntent>) {
    currentIntents.current = next;
    memory.put(account.userId, projectId, next);
    setIntents(next);
  }
  function changeExclusions(excludedTags: string[]) {
    const next = identityReferenceQuerySchema.parse({ limit: 40, excludedTags });
    if (JSON.stringify(next.excludedTags) === JSON.stringify(requestedQuery.current.excludedTags)) return;
    // The schema trims and sorts tags. Compare before invalidating the read,
    // using the latest requested set rather than a potentially stale render.
    requestedQuery.current = next;
    epoch.current += 1;
    sequence.current += 1;
    controller.current?.abort();
    pageQueries.current = [next];
    entryQueries.current.clear();
    setPage(null);
    setQuery(next);
    setLoading(true);
    setLoadingMore(false);
    setError(null);
  }
  async function loadMore() {
    if (!page?.references.nextCursor || loading || morePending.current || mutations.current.size || !eligible) return;
    morePending.current = true;
    setLoadingMore(true);
    setError(null);
    const input = identityReferenceQuerySchema.parse({ ...query, cursor: page.references.nextCursor }),
      read = new AbortController();
    controller.current = read;
    const observedEpoch = epoch.current,
      observedSequence = ++sequence.current;
    try {
      const reply = await client.list(input, read.signal);
      if (!reply || observedEpoch !== epoch.current || observedSequence !== sequence.current) return;
      if (
        reply.referenceRevision !== page.referenceRevision ||
        reply.selectedReferenceCount !== page.selectedReferenceCount
      )
        throw new Error("Changed reference pages");
      reply.references.items.forEach((entry) => entryQueries.current.set(entry.reference.id, input));
      pageQueries.current.push(input);
      setFilterMetadata((previous) => ({
        referenceRevision: reply.referenceRevision,
        selectedReferenceCount: reply.selectedReferenceCount,
        availableTags: [...new Set([...(previous?.availableTags ?? []), ...reply.availableTags])],
        tagsComplete: (previous?.tagsComplete ?? true) && reply.tagsComplete,
      }));
      setPage((previous) => {
        if (!previous) return null;
        const rows = new Map(previous.references.items.map((entry) => [entry.reference.id, entry]));
        reply.references.items.forEach((entry) => rows.set(entry.reference.id, entry));
        return {
          ...previous,
          availableTags: [...new Set([...previous.availableTags, ...reply.availableTags])],
          tagsComplete: previous.tagsComplete && reply.tagsComplete,
          references: { items: [...rows.values()], nextCursor: reply.references.nextCursor },
        };
      });
    } catch (cause) {
      if (client.current() && !read.signal.aborted && observedEpoch === epoch.current)
        setError(referenceErrorMessage(cause));
    } finally {
      morePending.current = false;
      if (client.current()) setLoadingMore(false);
    }
  }
  function publishReceipt(receipt: SetReferenceReactionResponse) {
    setFilterMetadata((previous) =>
      previous && receipt.referenceRevision >= previous.referenceRevision
        ? {
            ...previous,
            referenceRevision: receipt.referenceRevision,
            selectedReferenceCount: receipt.selectedReferenceCount,
          }
        : previous,
    );
    latestRevision.current = Math.max(latestRevision.current, receipt.referenceRevision);
    setPage((previous) => (previous ? applyReferenceReceipt(previous, receipt) : previous));
  }
  async function react(entry: IdentityReferenceEntry, choices: ReferenceChoices, replaceIntent = false) {
    const id = entry.reference.id;
    if (
      !eligible ||
      !client.current() ||
      mutations.current.has(id) ||
      (!replaceIntent && currentIntents.current.has(id))
    )
      return;
    const input = setReferenceReactionSchema.parse({ expectedRevision: entry.reaction.revision, ...choices });
    if (equalChoices(entry.reaction, input)) return;
    const originQuery = currentIntents.current.get(id)?.query ?? entryQueries.current.get(id);
    if (!originQuery) return;
    const intent: ReferenceIntent = {
      entry,
      query: originQuery,
      choices: { ensemble: input.ensemble, elements: input.elements },
      phase: "unconfirmed",
      error: "Your choices have not been confirmed yet.",
    };
    publishIntents(new Map(currentIntents.current).set(id, intent));
    mutations.current.add(id);
    setPending(new Set(mutations.current));
    epoch.current += 1;
    controller.current?.abort();
    try {
      const receipt = await client.react(entry, input);
      if (!receipt) return;
      publishReceipt(receipt);
      const next = new Map(currentIntents.current);
      next.delete(id);
      publishIntents(next);
      refreshNeeded.current = true;
    } catch (cause) {
      if (client.current())
        publishIntents(
          new Map(currentIntents.current).set(id, { ...intent, error: referenceErrorMessage(cause, true) }),
        );
    } finally {
      mutations.current.delete(id);
      if (client.current()) {
        setPending(new Set(mutations.current));
        setLoading(false);
        if (!mutations.current.size && refreshNeeded.current) {
          refreshNeeded.current = false;
          refresh();
        }
      }
    }
  }
  async function checkIntent(id: string) {
    const intent = currentIntents.current.get(id);
    if (!intent || mutations.current.has(id) || !eligible) return;
    mutations.current.add(id);
    setPending(new Set(mutations.current));
    epoch.current += 1;
    controller.current?.abort();
    try {
      const reply = await client.list(intent.query);
      if (!reply) return;
      const entry = reply.references.items.find((row) => row.reference.id === id);
      if (!entry) throw new Error("Reference not present in checked page");
      publishReceipt({
        ownerId: reply.ownerId,
        projectId: reply.projectId,
        referenceRevision: reply.referenceRevision,
        selectedReferenceCount: reply.selectedReferenceCount,
        entry,
      });
      const next = new Map(currentIntents.current);
      if (equalChoices(entry.reaction, intent.choices)) next.delete(id);
      else
        next.set(id, {
          ...intent,
          entry,
          phase: "conflict",
          error: "The saved choices are shown below. Your pending choices are still here.",
        });
      publishIntents(next);
    } catch (cause) {
      if (client.current())
        publishIntents(new Map(currentIntents.current).set(id, { ...intent, error: referenceErrorMessage(cause) }));
    } finally {
      mutations.current.delete(id);
      if (client.current()) {
        setPending(new Set(mutations.current));
        setLoading(false);
      }
    }
  }
  function keepSaved(id: string) {
    const next = new Map(currentIntents.current);
    next.delete(id);
    publishIntents(next);
    refresh();
  }
  return {
    client,
    project,
    projectError,
    blocked,
    page,
    filterMetadata,
    query,
    loading,
    loadingMore,
    error,
    intents,
    pending,
    refresh,
    checkProject: () => setProjectReload((value) => value + 1),
    changeExclusions,
    loadMore,
    react,
    checkIntent,
    keepSaved,
  };
}
