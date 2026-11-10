"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  identityColorsSchema,
  identityPreferencesSchema,
  initialIdentityPreferences,
  type IdentitySystemCursor,
  type IdentitySystemSummary,
  type IdentitySystemVersion,
  type ProjectIdentityOverview,
  type RefineIdentityComponent,
} from "@/domain/project-identity";
import { AccountRequestError } from "@/components/workspace/account-api";
import { IMAGE_INPUT_LIMITS } from "@/domain/logo-image-limits";
import { useAccountSession } from "@/components/workspace/account-session";
import { accountDraftChanged } from "@/components/workspace/account-draft-memory";
import {
  createAccountIdentityClient,
  identityErrorMessage,
  identityObservation,
  type IdentityObservation,
} from "./account-identity-client";
import {
  identityColorForm,
  identityDraftChanged,
  identityPreferenceForm,
  identityTypographyForm,
  parseIdentityTypographyForm,
  type IdentityColorDraft,
  type IdentityColorForm,
  type IdentityDraft,
  type IdentityPreferenceDraft,
  type IdentityPreferenceForm,
  type IdentityTypographyDraft,
  type IdentityTypographyForm,
} from "./identity-draft-memory";
import { useIdentityGeneration } from "./use-identity-generation";

export type IdentityReferenceHint = {
  ownerId: string;
  projectId: string;
  generation: number;
  referenceRevision: number | null;
  pending: boolean;
};
type State = {
  scope: string;
  overview: ProjectIdentityOverview | null;
  items: IdentitySystemSummary[];
  nextCursor: IdentitySystemCursor | null;
  detail: IdentitySystemVersion | null;
  loading: boolean;
  loadingMore: boolean;
  detailLoading: boolean;
  pending: boolean;
  checked: boolean;
  selectionUncertain: boolean;
  preferenceRecoveryChecked: string | null;
  error: string | null;
  notice: string | null;
};
const emptyDrafts: readonly IdentityDraft[] = Object.freeze([]);
const freshState = (scope: string): State => ({
  scope,
  overview: null,
  items: [],
  nextCursor: null,
  detail: null,
  loading: false,
  loadingMore: false,
  detailLoading: false,
  pending: false,
  checked: false,
  selectionUncertain: false,
  preferenceRecoveryChecked: null,
  error: null,
  notice: null,
});
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const heads = (overview: ProjectIdentityOverview) => [
  overview.project.current_revision,
  overview.referenceSnapshot.referenceRevision,
  overview.preferences?.revision ?? 0,
  overview.session?.identityRevision ?? 0,
];
const knownRejection = (error: unknown) =>
  error instanceof AccountRequestError && [404, 409, 422].includes(error.status);

export function useProjectIdentity(
  projectId: string,
  referenceState?: IdentityReferenceHint,
  options?: { logoDirections?: boolean },
) {
  const account = useAccountSession(),
    { session, isCurrent, expire, drafts, identityDrafts } = account;
  const verified = session.status === "ready" ? session : null;
  const scope = verified ? `${verified.userId}:${verified.generation}:${projectId}` : "";
  const client = useMemo(
    () => (session.status === "ready" ? createAccountIdentityClient(session, projectId, isCurrent, expire) : null),
    [session, projectId, isCurrent, expire],
  );
  const [state, setState] = useState<State>(() => freshState(""));
  const stateRef = useRef(state),
    readEpoch = useRef(0),
    detailEpoch = useRef(0),
    mutation = useRef<symbol | null>(null);
  const readAbort = useRef<AbortController | null>(null),
    detailAbort = useRef<AbortController | null>(null);
  const referenceAttempt = useRef<{ client: typeof client; revision: number } | null>(null);
  stateRef.current = state;
  const publish = useCallback((update: (previous: State) => State) => {
    const next = update(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);
  const valid = useCallback(() => Boolean(client?.current()), [client]);
  const refresh = useCallback(async () => {
    if (!client?.current() || mutation.current) return;
    const epoch = ++readEpoch.current;
    readAbort.current?.abort();
    const controller = new AbortController();
    readAbort.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    publish((previous) => ({
      ...(previous.scope === scope ? previous : freshState(scope)),
      loading: true,
      checked: false,
      error: null,
    }));
    try {
      const overview = await client.overview({}, controller.signal);
      if (!client.current() || epoch !== readEpoch.current) return;
      if (!overview || controller.signal.aborted) throw new AccountRequestError(503);
      publish((previous) => ({
        ...(previous.scope === scope ? previous : freshState(scope)),
        overview,
        items: overview.systems.items,
        nextCursor: overview.systems.nextCursor,
        loading: false,
        loadingMore: false,
        checked: true,
        selectionUncertain: false,
        preferenceRecoveryChecked: (() => {
          const draft = identityDrafts.get({ kind: "preferences", ownerId: overview.ownerId, projectId });
          return draft?.kind === "preferences" && draft.pending ? JSON.stringify(draft.pending.request) : null;
        })(),
        error: null,
      }));
    } catch (error) {
      if (client.current() && epoch === readEpoch.current)
        publish((previous) => ({
          ...previous,
          loading: false,
          loadingMore: false,
          error: identityErrorMessage(error),
        }));
    } finally {
      clearTimeout(timeout);
      if (readAbort.current === controller) readAbort.current = null;
    }
  }, [client, scope, publish, identityDrafts, projectId]);
  useEffect(() => {
    if (!client) return;
    client.activate();
    mutation.current = null;
    const start = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      window.clearTimeout(start);
      readEpoch.current += 1;
      detailEpoch.current += 1;
      client.dispose();
    };
  }, [client, refresh]);

  const shown = state.scope === scope && valid() ? state : freshState(scope);
  const overview = shown.overview;
  const hintValid =
    referenceState &&
    verified &&
    referenceState.ownerId === verified.userId &&
    referenceState.projectId === projectId &&
    referenceState.generation === verified.generation;
  const referencesPending = Boolean(
    referenceState &&
    (!hintValid ||
      referenceState.pending ||
      referenceState.referenceRevision === null ||
      (overview && referenceState.referenceRevision !== overview.referenceSnapshot.referenceRevision)),
  );
  const hintedRevision = hintValid ? referenceState.referenceRevision : null;
  useEffect(() => {
    if (
      hintedRevision === null ||
      !overview ||
      shown.loading ||
      shown.pending ||
      hintedRevision === overview.referenceSnapshot.referenceRevision
    )
      return;
    if (referenceAttempt.current?.client === client && referenceAttempt.current.revision === hintedRevision) return;
    const start = window.setTimeout(() => {
      if (!client?.current() || mutation.current) return;
      // One automatic read per observed target. A failed or still-lagging read
      // must settle; Check latest remains available, and a new target can retry.
      referenceAttempt.current = { client, revision: hintedRevision };
      void refresh();
    }, 0);
    return () => window.clearTimeout(start);
  }, [client, hintedRevision, overview, shown.loading, shown.pending, refresh]);

  const strategyDraft = useSyncExternalStore(
    drafts.subscribe,
    () => drafts.get(projectId),
    () => null,
  );
  const retained = useSyncExternalStore(
    identityDrafts.subscribe,
    () => (verified ? identityDrafts.list(verified.userId, projectId) : emptyDrafts),
    () => emptyDrafts,
  );
  const preferenceDraft =
    retained.find((draft): draft is IdentityPreferenceDraft => draft.kind === "preferences") ?? null;
  const strategyDirty = Boolean(
    verified &&
    strategyDraft?.ownerId === verified.userId &&
    (strategyDraft.conflict || accountDraftChanged(strategyDraft)),
  );
  const preferencesDirty = Boolean(preferenceDraft && identityDraftChanged(preferenceDraft));
  const savesUnavailable = overview?.saveAvailability.status !== "available";
  const blocked =
    savesUnavailable ||
    !shown.checked ||
    shown.selectionUncertain ||
    !overview ||
    overview.currentBasis.status !== "available" ||
    shown.loading ||
    shown.detailLoading ||
    shown.pending ||
    referencesPending ||
    strategyDirty ||
    preferencesDirty;
  const selectionBlockedReason = shown.pending
    ? "Saving your changes…"
    : shown.loading || shown.detailLoading
      ? "Checking your saved choice…"
      : shown.selectionUncertain
        ? "Your last choice could not be confirmed. Check your saved choice before choosing again."
        : !shown.checked || !overview
          ? "Your saved choice could not be checked. Please try again."
          : savesUnavailable
            ? "Saving your direction is temporarily unavailable. Your boards are saved."
            : overview.currentBasis.status !== "available"
              ? "Review your saved brief and logo before choosing a direction."
              : strategyDirty
                ? "Save or resolve your project edits before choosing a direction."
                : preferencesDirty
                  ? "Save or discard your identity edits before choosing a direction."
                  : referencesPending
                    ? "Finish saving or checking your reference choices before choosing a direction."
                    : null;
  const selectionCheckAvailable =
    !shown.pending &&
    !strategyDirty &&
    !preferencesDirty &&
    (shown.loading ||
      shown.detailLoading ||
      !shown.checked ||
      shown.selectionUncertain ||
      savesUnavailable ||
      referencesPending);
  const system = shown.detail ?? overview?.currentSelection?.system ?? null;
  const preferenceRebaseReady =
    shown.checked &&
    (!preferenceDraft?.pending || shown.preferenceRecoveryChecked === JSON.stringify(preferenceDraft.pending.request));
  const preferenceValues =
    preferenceDraft?.value ??
    (overview
      ? identityPreferenceForm(
          overview.preferences?.preferences ?? initialIdentityPreferences(overview.project.context),
        )
      : null);
  const fence = overview ? JSON.stringify([scope, ...heads(overview), overview.currentBasis]) : scope;

  function setError(message: string) {
    if (valid()) publish((previous) => ({ ...previous, error: message, notice: null }));
  }
  function retain(draft: IdentityDraft) {
    try {
      if (identityDrafts.set(draft)) return true;
      setError(
        "This edit could not be retained. Resolve or discard an existing recovery record, or save another open draft first.",
      );
    } catch {
      setError("This edit could not be retained. Check the entered values.");
    }
    return false;
  }
  function preferenceBaseline(): IdentityPreferenceDraft | null {
    if (!verified || !overview) return null;
    const baseline = overview.preferences?.preferences ?? initialIdentityPreferences(overview.project.context);
    return {
      kind: "preferences",
      ownerId: verified.userId,
      projectId,
      baselineRevision: overview.preferences?.revision ?? 0,
      baseline,
      value: identityPreferenceForm(baseline),
      pending: null,
    };
  }
  function setPreferenceValues(value: IdentityPreferenceForm) {
    if (!valid() || shown.pending || preferenceDraft?.pending) return;
    const draft = preferenceDraft ?? preferenceBaseline();
    if (draft) retain({ ...draft, value });
  }
  function discardPreference() {
    if (valid() && preferenceDraft && !shown.pending) identityDrafts.remove(preferenceDraft);
  }
  function keepPreferencesAgainstLatest() {
    if (!valid() || !preferenceDraft || shown.pending || shown.loading || !preferenceRebaseReady) return;
    const next = preferenceBaseline();
    if (!next) return;
    identityDrafts.remove(preferenceDraft);
    retain({ ...next, value: preferenceDraft.value });
    publish((previous) => ({
      ...previous,
      error: null,
      notice: "Your edits now use the latest saved preferences as their baseline. Review them before saving.",
    }));
  }
  async function begin<T>(run: () => Promise<T | null>, finish: (result: T) => void, rejected?: () => void) {
    if (!client?.current() || mutation.current) return;
    const token = Symbol("Identity mutation");
    mutation.current = token;
    readEpoch.current += 1;
    readAbort.current?.abort();
    publish((previous) => ({
      ...previous,
      pending: true,
      loading: false,
      loadingMore: false,
      error: null,
      notice: null,
    }));
    try {
      const result = await run();
      if (!result || !client.current()) return;
      finish(result);
    } catch (error) {
      if (!client.current()) return;
      if (knownRejection(error)) rejected?.();
      publish((previous) => ({ ...previous, error: identityErrorMessage(error, "write") }));
    } finally {
      if (mutation.current === token) {
        mutation.current = null;
        if (client.current()) publish((previous) => ({ ...previous, pending: false }));
      }
    }
  }
  async function savePreferences() {
    if (
      !client?.current() ||
      !overview ||
      !preferenceDraft ||
      preferenceDraft.pending ||
      shown.pending ||
      shown.loading ||
      !shown.checked
    )
      return;
    if (preferenceDraft.baselineRevision !== (overview.preferences?.revision ?? 0)) {
      setError("Saved preferences changed. Check the latest, then keep your edits against that baseline.");
      return;
    }
    const parsed = identityPreferencesSchema.safeParse({ version: 1, ...preferenceDraft.value });
    if (!parsed.success) {
      setError("Check the locale and preference notes before saving.");
      return;
    }
    const request = { expectedPreferencesRevision: preferenceDraft.baselineRevision, preferences: parsed.data };
    const pending = { ...preferenceDraft, pending: { request } };
    if (!retain(pending)) return;
    let saved = false;
    await begin(
      () => client.preferences(request),
      () => {
        identityDrafts.remove(pending);
        saved = true;
      },
      () => {
        identityDrafts.remove(pending);
        retain({ ...pending, pending: null });
      },
    );
    if (saved && client.current()) {
      await refresh();
      publish((previous) => ({ ...previous, notice: "Identity preferences saved." }));
    }
  }
  async function loadMore() {
    const before = stateRef.current;
    if (
      !client?.current() ||
      before.scope !== scope ||
      !before.overview ||
      !before.nextCursor ||
      before.loadingMore ||
      before.loading ||
      mutation.current
    )
      return;
    const cursor = before.nextCursor,
      epoch = ++readEpoch.current;
    publish((previous) => ({ ...previous, loadingMore: true, error: null }));
    try {
      const reply = await client.overview({ cursor });
      if (!reply || !client.current() || epoch !== readEpoch.current) return;
      if (!equal(heads(before.overview), heads(reply)) || !equal(before.overview.currentBasis, reply.currentBasis)) {
        await refresh();
        return;
      }
      if (reply.systems.items.some((item) => before.items.some((previous) => previous.id === item.id)))
        throw new AccountRequestError(502);
      publish((previous) => ({
        ...previous,
        items: [...before.items, ...reply.systems.items],
        nextCursor: reply.systems.nextCursor,
        loadingMore: false,
      }));
    } catch (error) {
      if (client.current() && epoch === readEpoch.current)
        publish((previous) => ({ ...previous, loadingMore: false, error: identityErrorMessage(error) }));
    }
  }
  async function viewSystem(systemVersionId: string) {
    if (!client?.current() || mutation.current) return;
    // Viewing the same verified immutable version is not a refresh. Recovery
    // reads after an error and every different target remain explicit reads.
    if (shown.checked && !shown.error && !shown.detailLoading && system?.id === systemVersionId) return;
    const epoch = ++detailEpoch.current;
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    publish((previous) => ({ ...previous, detail: null, detailLoading: true, error: null }));
    try {
      const detail = await client.detail(systemVersionId, controller.signal);
      if (!detail || !client.current() || epoch !== detailEpoch.current) return;
      publish((previous) => ({ ...previous, detail: detail.system, detailLoading: false }));
      if (stateRef.current.overview && !equal(stateRef.current.overview.currentBasis, detail.currentBasis))
        await refresh();
    } catch (error) {
      if (client.current() && epoch === detailEpoch.current)
        publish((previous) => ({ ...previous, detailLoading: false, error: identityErrorMessage(error) }));
    }
  }
  async function chooseSystem(acceptEarlierBasis: boolean, selectedSystem: IdentitySystemVersion | null = system) {
    if (
      !client?.current() ||
      !overview ||
      !selectedSystem ||
      blocked ||
      overview.currentSelection?.system.id === selectedSystem.id
    )
      return;
    const observed = identityObservation(overview),
      request = {
        systemVersionId: selectedSystem.id,
        expectedProjectRevision: observed.projectRevision,
        expectedReferenceRevision: observed.referenceRevision,
        expectedPreferencesRevision: observed.preferencesRevision,
        expectedIdentityRevision: observed.identityRevision,
        acceptEarlierBasis,
      };
    let saved = false;
    await begin(
      () => client.select(request, observed, selectedSystem),
      () => {
        saved = true;
      },
    );
    if (saved && client.current()) {
      await refresh();
      publish((previous) => ({
        ...previous,
        notice: previous.checked
          ? "Current Identity choice saved."
          : "The choice was saved. Check the latest to verify the current selection.",
      }));
    } else if (client.current()) publish((previous) => ({ ...previous, selectionUncertain: true }));
  }
  function componentDraft(component: "colors"): IdentityColorDraft | null;
  function componentDraft(component: "typography"): IdentityTypographyDraft | null;
  function componentDraft(component: "colors" | "typography"): IdentityColorDraft | IdentityTypographyDraft | null {
    if (!system || !verified || !overview) return null;
    const found = retained.find(
      (draft) => draft.kind === "component" && draft.baseSystemVersionId === system.id && draft.component === component,
    );
    if (found?.kind === "component") return found;
    const key = {
      kind: "component" as const,
      ownerId: verified.userId,
      projectId,
      baseSystemVersionId: system.id,
      pending: null,
    };
    return component === "colors"
      ? { ...key, component, baseline: system.components.colors, value: identityColorForm(system.components.colors) }
      : {
          ...key,
          component,
          baseline: system.components.typography,
          value: identityTypographyForm(system.components.typography),
        };
  }
  function setColors(value: IdentityColorForm) {
    const draft = componentDraft("colors");
    if (valid() && draft && !shown.pending && !draft.pending) retain({ ...draft, value });
  }
  function setTypography(value: IdentityTypographyForm) {
    const draft = componentDraft("typography");
    if (valid() && draft && !shown.pending && !draft.pending) retain({ ...draft, value });
  }
  function discardComponent(component: "colors" | "typography") {
    if (!valid() || !system || !verified || shown.pending) return;
    identityDrafts.remove({
      kind: "component",
      ownerId: verified.userId,
      projectId,
      baseSystemVersionId: system.id,
      component,
    });
  }
  async function saveComponent(component: "colors" | "typography", acceptEarlierBasis: boolean, retry = false) {
    if (!client?.current() || !overview || !system || blocked) return;
    const draft = component === "colors" ? componentDraft("colors") : componentDraft("typography");
    if (!draft) return;
    let request: RefineIdentityComponent, observed: IdentityObservation;
    if (retry) {
      if (!draft.pending) return;
      request = draft.pending.request;
      observed = {
        ownerId: draft.ownerId,
        projectId: draft.projectId,
        projectRevision: request.expectedProjectRevision,
        referenceRevision: request.expectedReferenceRevision,
        preferencesRevision: request.expectedPreferencesRevision,
        identityRevision: request.expectedIdentityRevision,
        basis: draft.pending.basis,
        previousSelectionId: draft.pending.previousSelectionId,
      };
    } else {
      if (draft.pending) return;
      observed = identityObservation(overview);
      const common = {
        baseSystemVersionId: system.id,
        expectedProjectRevision: observed.projectRevision,
        expectedReferenceRevision: observed.referenceRevision,
        expectedPreferencesRevision: observed.preferencesRevision,
        expectedIdentityRevision: observed.identityRevision,
        acceptEarlierBasis: !equal(system.input.basis, observed.basis) && acceptEarlierBasis,
        idempotencyKey: crypto.randomUUID(),
      };
      try {
        request =
          draft.component === "colors"
            ? { ...common, component: "colors", input: identityColorsSchema.parse(draft.value) }
            : { ...common, component: "typography", input: parseIdentityTypographyForm(draft.value) };
        if (equal(request.input, draft.baseline)) {
          setError("Make a component change before saving a new version.");
          return;
        }
      } catch {
        setError("Check the component values before saving a new version.");
        return;
      }
    }
    const pending = {
      ...draft,
      pending: { request, basis: observed.basis, previousSelectionId: observed.previousSelectionId },
    };
    if (!retain(pending)) return;
    let saved = false;
    await begin(
      () => client.refine(request, observed, system),
      (result) => {
        identityDrafts.remove(pending);
        saved = true;
        publish((previous) => ({ ...previous, detail: result.system }));
      },
      () => {
        identityDrafts.remove(pending);
        retain({ ...pending, pending: null });
      },
    );
    if (saved && client.current()) {
      await refresh();
      publish((previous) => ({
        ...previous,
        notice: previous.checked
          ? "The manual edit is saved in history. The latest current choice has been checked."
          : "The manual edit is saved in history. Check the latest before choosing or refining again.",
      }));
    }
  }
  const generationBlockedReason =
    !overview || !shown.checked || shown.loading || shown.pending || shown.selectionUncertain
      ? "Check the latest saved inputs before generating."
      : strategyDirty
        ? "Save or resolve your project edits before generating."
        : referencesPending
          ? "Finish checking your reference choices before generating."
          : retained.some(identityDraftChanged)
            ? "Save or discard your Identity edits before generating."
            : overview.referenceSnapshot.selectedReferenceCount > IMAGE_INPUT_LIMITS.images
              ? `Choose one to ${IMAGE_INPUT_LIMITS.images} references for generation. Your other saved choices are kept until you change them.`
              : !options?.logoDirections && !overview.readiness.ready
                ? overview.readiness.blocking.includes("references")
                  ? "Select at least one owned reference before generating."
                  : "Finish the saved brief, strategy and brand name before generating."
                : null;
  const generation = useIdentityGeneration({
    account: verified,
    projectId,
    client,
    memory: identityDrafts,
    canStart: (input) =>
      !generationBlockedReason &&
      Boolean(
        overview &&
        "version" in input &&
        input.version === (options?.logoDirections ? 3 : 2) &&
        input.expectedProjectRevision === overview.project.current_revision &&
        input.expectedReferenceRevision === overview.referenceSnapshot.referenceRevision &&
        input.expectedPreferencesRevision === (overview.preferences?.revision ?? 0) &&
        input.expectedIdentityRevision === (overview.session?.identityRevision ?? 0),
      ),
    onResults: () => {
      void refresh();
    },
  });
  return {
    client,
    verified,
    overview,
    system,
    generation,
    generationBlockedReason,
    items: shown.items,
    nextCursor: shown.nextCursor,
    loading: shown.loading,
    loadingMore: shown.loadingMore,
    detailLoading: shown.detailLoading,
    pending: shown.pending,
    savesUnavailable,
    checked: shown.checked,
    selectionUncertain: shown.selectionUncertain,
    selectionBlockedReason,
    selectionCheckAvailable,
    preferenceRebaseReady,
    error: shown.error,
    notice: shown.notice,
    blocked,
    strategyDirty,
    preferencesDirty,
    referencesPending,
    retained,
    preferenceDraft,
    preferenceValues,
    colors: componentDraft("colors"),
    typography: componentDraft("typography"),
    fence,
    refresh,
    loadMore,
    viewSystem,
    chooseSystem,
    setPreferenceValues,
    discardPreference,
    keepPreferencesAgainstLatest,
    savePreferences,
    setColors,
    setTypography,
    discardComponent,
    saveComponent,
  };
}
export type ProjectIdentityController = ReturnType<typeof useProjectIdentity>;
