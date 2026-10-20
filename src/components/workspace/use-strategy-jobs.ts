"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { accountProjectResponseSchema } from "@/domain/project-api";
import { applyStrategyJobResponseSchema, strategyJobResponseSchema, strategyOverviewResponseSchema, type StrategyJob, type StrategyOperation, type StrategyOverview } from "@/domain/strategy-jobs";
import { AccountRequestError } from "./account-api";
import { boundedAccountRequest } from "./bounded-account-request";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import { accountDraftChanged, type AccountWorkspace } from "./account-draft-memory";
import { accountProjectDraft } from "./project-draft-adapter";
import { canContinueStrategy, forgetStrategyIntent, readStrategyIntent, strategyApplicationMatchesResult, strategyCanRetryDelivery, strategyErrorMessage, strategyIdempotencyKey, strategyIntentPlan, strategyJobActive, strategyJobMatchesRequest, strategyRequestPayload, strategyResultApplication, verifyStrategyJobs, type StrategyAllowance } from "./account-strategy-client";

type ReadState = { identity: string; overview: StrategyOverview | null; error: string | null };
type ActionState = {
  identity: string; pending: boolean; error: string | null; pendingLabel?: string;
  unconfirmedEnqueue?: { epoch: number; operation: StrategyOperation; revision: number; allowance: StrategyAllowance };
};

export function useStrategyJobs({ account, workspace, blocked, guided = false }: { account: VerifiedAccount; workspace: AccountWorkspace; blocked: boolean; guided?: boolean }) {
  const { isCurrent, expire, drafts } = useAccountSession();
  const projectId = workspace.saved.id;
  const identity = `${account.userId}:${account.generation}:${projectId}`;
  const [read, setRead] = useState<ReadState | null>(null);
  const [action, setAction] = useState<ActionState | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const live = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const mutationEpoch = useRef(0);
  const inFlight = useRef(false);
  const chainAttempts = useRef(new Set<string>());
  const recoveryAttempts = useRef(new Set<string>());
  const refresh = useCallback(() => setRefreshVersion(value => value + 1), []);
  const getWorkspace = useCallback(() => {
    if (!live.current || !isCurrent(account)) return null;
    const current = drafts.get(projectId);
    return current?.ownerId === account.userId && current.generation === account.generation && current.saved.id === projectId ? current : null;
  }, [account, drafts, isCurrent, projectId]);
  useEffect(() => {
    live.current = true;
    const pending = controllers.current;
    return () => { live.current = false; for (const controller of pending) controller.abort(); pending.clear(); };
  }, [identity]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const epoch = mutationEpoch.current;
      let soon = false;
      try {
        const overview = await boundedAccountRequest(`/api/projects/${projectId}/strategy`, strategyOverviewResponseSchema, { signal: controller.signal });
        if (controller.signal.aborted || !getWorkspace()) return;
        if (!verifyStrategyJobs(overview.jobs, account.userId, projectId)) { expire(account); return; }
        soon = overview.jobs.some(strategyJobActive);
        if (epoch === mutationEpoch.current) {
          setRead({ identity, overview, error: null });
          setAction(previous => {
            const request = previous?.unconfirmedEnqueue;
            if (previous?.identity !== identity || previous.pending || !request || request.epoch !== epoch || epoch !== mutationEpoch.current) return previous;
            // Confirm the saved operation only from one matching owned job;
            // ambiguous history cannot resolve an unknown acknowledgement.
            return overview.jobs.filter(job => strategyJobMatchesRequest(job, request.operation, request.revision, request.allowance)).length === 1
              ? { identity, pending: false, error: null } : previous;
          });
        }
      } catch (error: unknown) {
        if (controller.signal.aborted || !getWorkspace()) return;
        if (error instanceof AccountRequestError && error.status === 401) { expire(account); return; }
        setRead(previous => ({ identity, overview: previous?.identity === identity ? previous.overview : null, error: strategyErrorMessage(error) }));
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), soon ? 1500 : 15000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [account, expire, getWorkspace, identity, projectId, refreshVersion]);

  const overview = read?.identity === identity ? read.overview : null;
  const readError = read?.identity === identity ? read.error : null;
  const pending = action?.identity === identity && action.pending;
  const pendingLabel = action?.identity === identity ? action.pendingLabel ?? "Submitting your request…" : "Submitting your request…";
  const actionError = action?.identity === identity ? action.error : null;
  const report = useCallback((message: string) => setAction({ identity, pending: false, error: message }), [identity]);

  const enqueue = useCallback(async (operation: StrategyOperation, revision: number, allowance: StrategyAllowance) => {
    const current = getWorkspace();
    if (!current || inFlight.current) return null;
    if (current.conflict || accountDraftChanged(current) || current.saved.current_revision !== revision) {
      report("Your draft changed before the request was submitted. Save your current edits before requesting a proposal."); return null;
    }
    const controller = new AbortController(); controllers.current.add(controller); inFlight.current = true;
    const epoch = ++mutationEpoch.current;
    setAction({ identity, pending: true, error: null });
    try {
      const { job } = await boundedAccountRequest(`/api/projects/${projectId}/strategy`, strategyJobResponseSchema, { method: "POST", signal: controller.signal, body: strategyRequestPayload(projectId, revision, operation, allowance) });
      if (controller.signal.aborted || !getWorkspace()) return null;
      if (!verifyStrategyJobs([job], account.userId, projectId)) { expire(account); return null; }
      if (!strategyJobMatchesRequest(job, operation, revision, allowance)) throw new AccountRequestError(502);
      setRead(previous => previous?.identity === identity && previous.overview ? { ...previous, overview: { ...previous.overview, jobs: [job, ...previous.overview.jobs.filter(item => item.id !== job.id)].slice(0, 64) } } : previous);
      setAction({ identity, pending: false, error: null }); refresh(); return job;
    } catch (error: unknown) {
      if (controller.signal.aborted || !getWorkspace()) return null;
      if (error instanceof AccountRequestError && error.status === 401) expire(account);
      else {
        const unconfirmed = !(error instanceof AccountRequestError) || error.status === 408 || error.status >= 500;
        setAction({ identity, pending: false, error: strategyErrorMessage(error), ...(unconfirmed ? {
          unconfirmedEnqueue: { epoch, operation, revision, allowance },
        } : {}) });
      }
      refresh(); return null;
    } finally { controllers.current.delete(controller); inFlight.current = false; }
  }, [account, expire, getWorkspace, identity, projectId, refresh, report]);

  const retryDelivery = useCallback(async (job: StrategyJob) => {
    const current = getWorkspace();
    const latest = overview?.jobs.find(item => item.id === job.id);
    if (!current || blocked || readError || inFlight.current || current.conflict || accountDraftChanged(current)
      || !latest || !verifyStrategyJobs([job, latest], account.userId, projectId)
      || latest.operation !== job.operation || latest.input_revision !== job.input_revision
      || !strategyCanRetryDelivery(latest, current.saved.current_revision)) return;
    const controller = new AbortController(); controllers.current.add(controller); inFlight.current = true;
    mutationEpoch.current += 1;
    setAction({ identity, pending: true, pendingLabel: "Retrying delivery of your saved request…", error: null });
    try {
      const { job: updated } = await boundedAccountRequest(`/api/projects/${projectId}/strategy/${job.id}/delivery`, strategyJobResponseSchema, {
        method: "POST", body: {}, expectedOwnerId: account.userId, signal: controller.signal,
      });
      if (controller.signal.aborted || !getWorkspace()) return;
      if (!verifyStrategyJobs([updated], account.userId, projectId)) { expire(account); return; }
      if (updated.id !== job.id || updated.operation !== job.operation || updated.input_revision !== job.input_revision
        || updated.billingMode === "chatgpt_subscription") throw new AccountRequestError(502);
      setRead(previous => previous?.identity === identity && previous.overview ? { ...previous, overview: {
        ...previous.overview, jobs: previous.overview.jobs.map(item => item.id === job.id ? updated : item),
      } } : previous);
      setAction({ identity, pending: false, error: updated.dispatchState === "dispatch_pending"
        ? "Delivery is still unconfirmed. The same saved request is kept. Check status before retrying delivery." : null });
      refresh();
    } catch (error: unknown) {
      if (controller.signal.aborted || !getWorkspace()) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(account);
      else report(error instanceof AccountRequestError && [404, 409].includes(error.status)
        ? "This request changed and cannot be sent again. Check its latest status."
        : "Delivery could not be confirmed. The same saved request is kept. Check status before retrying delivery.");
      refresh();
    } finally { controllers.current.delete(controller); inFlight.current = false; }
  }, [account, blocked, expire, getWorkspace, identity, overview, projectId, readError, refresh, report]);

  const cancel = useCallback(async (job: StrategyJob) => {
    if (!getWorkspace() || inFlight.current || !strategyJobActive(job)) return;
    forgetStrategyIntent(account.userId, projectId, job.input_revision);
    if (job.operation === "strategy.competitors") forgetStrategyIntent(account.userId, projectId, job.input_revision - 1);
    const controller = new AbortController(); controllers.current.add(controller); inFlight.current = true;
    mutationEpoch.current += 1; setAction({ identity, pending: true, error: null });
    try {
      const response = await boundedAccountRequest(`/api/projects/${projectId}/strategy/${job.id}`, strategyJobResponseSchema, { method: "DELETE", signal: controller.signal });
      if (controller.signal.aborted || !getWorkspace()) return;
      if (!verifyStrategyJobs([response.job], account.userId, projectId)) { expire(account); return; }
      if (response.job.id !== job.id || response.job.operation !== job.operation || response.job.input_revision !== job.input_revision) throw new AccountRequestError(502);
      setRead(previous => previous?.identity === identity && previous.overview ? { ...previous, overview: { ...previous.overview, jobs: previous.overview.jobs.map(item => item.id === job.id ? response.job : item) } } : previous);
      setAction({ identity, pending: false, error: null }); refresh();
    } catch (error: unknown) {
      if (controller.signal.aborted || !getWorkspace()) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(account);
      else report(strategyErrorMessage(error));
    } finally { controllers.current.delete(controller); inFlight.current = false; }
  }, [account, expire, getWorkspace, identity, projectId, refresh, report]);

  const apply = useCallback(async (job: StrategyJob, stepKey: string) => {
    const before = getWorkspace();
    if (!before || inFlight.current || before.conflict || accountDraftChanged(before) || job.input_revision !== before.saved.current_revision || !job.results.some(result => result.stepKey === stepKey) || strategyResultApplication(job, stepKey)) return;
    const controller = new AbortController(); controllers.current.add(controller); inFlight.current = true;
    mutationEpoch.current += 1;
    setAction({ identity, pending: true, error: null });
    try {
      const { project, application } = await boundedAccountRequest(`/api/projects/${projectId}/strategy/${job.id}/apply`, applyStrategyJobResponseSchema, { method: "POST", signal: controller.signal, body: { expectedRevision: before.saved.current_revision, stepKey } });
      const current = getWorkspace();
      if (controller.signal.aborted || !current) return;
      if (project.owner_id !== account.userId || project.id !== projectId) { expire(account); return; }
      if (project.current_revision !== before.saved.current_revision + 1 || project.scope !== before.saved.scope || !strategyApplicationMatchesResult(job, stepKey, application) || application.appliedRevision !== project.current_revision) throw new AccountRequestError(502);
      if (current.saved.current_revision !== before.saved.current_revision) { report("The project changed while the proposal was being applied. Your current draft is retained; check the latest version."); return; }
      const editedWhileWaiting = JSON.stringify(current.draft) !== JSON.stringify(before.draft);
      setRead(previous => previous?.identity === identity && previous.overview ? { ...previous, overview: { ...previous.overview, jobs: previous.overview.jobs.map(item => item.id === job.id ? { ...item, results: item.results.map(result => result.stepKey === stepKey ? { ...result, application } : result) } : item) } } : previous);
      drafts.set({ ...current, saved: project, draft: editedWhileWaiting ? current.draft : accountProjectDraft(project), conflict: editedWhileWaiting });
      setAction({ identity, pending: false, error: editedWhileWaiting ? "The proposal was applied to the saved version. Your newer edits are still in this tab; choose which version to keep before saving." : null });
      refresh();
    } catch (error: unknown) {
      const current = getWorkspace();
      if (controller.signal.aborted || !current) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(account);
      else {
        if (error instanceof AccountRequestError && error.status === 409) drafts.set({ ...current, conflict: true });
        report(strategyErrorMessage(error));
        refresh();
      }
    } finally { controllers.current.delete(controller); inFlight.current = false; }
  }, [account, drafts, expire, getWorkspace, identity, projectId, refresh, report]);

  const recoverAppliedVersion = useCallback(async (appliedRevision: number) => {
    const before = getWorkspace();
    if (!before || inFlight.current || before.conflict) return;
    const controller = new AbortController(); controllers.current.add(controller); inFlight.current = true;
    mutationEpoch.current += 1;
    setAction({ identity, pending: true, pendingLabel: "Checking the saved version…", error: null });
    try {
      const { project } = await boundedAccountRequest(`/api/projects/${projectId}`, accountProjectResponseSchema, { signal: controller.signal });
      const current = getWorkspace();
      if (controller.signal.aborted || !current) return;
      if (project.owner_id !== account.userId || project.id !== projectId) { expire(account); return; }
      if (project.current_revision < appliedRevision || project.scope !== before.saved.scope) throw new AccountRequestError(502);
      if (current.saved.current_revision !== before.saved.current_revision) { setAction({ identity, pending: false, error: null }); return; }
      const keepDraft = current.conflict || accountDraftChanged(current) || JSON.stringify(current.draft) !== JSON.stringify(before.draft);
      drafts.set({ ...current, saved: project, draft: keepDraft ? current.draft : accountProjectDraft(project), conflict: keepDraft });
      setAction({ identity, pending: false, error: keepDraft ? "The proposal was applied to the saved version. Your newer edits are still in this tab; choose which version to keep before saving." : null });
    } catch (error: unknown) {
      if (controller.signal.aborted || !getWorkspace()) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(account);
      else report(strategyErrorMessage(error));
    } finally { controllers.current.delete(controller); inFlight.current = false; }
  }, [account, drafts, expire, getWorkspace, identity, projectId, report]);

  const continueResearch = useCallback(async () => {
    if (!overview || readError || blocked) return;
    const current = getWorkspace();
    if (!current) return;
    const intent = readStrategyIntent(account.userId, projectId, current.saved.current_revision - 1);
    if (!intent || !canContinueStrategy(intent, current, overview)) return;
    const plan = strategyIntentPlan(intent);
    if (plan.kind === "response_only") return;
    const revision = current.saved.current_revision;
    chainAttempts.current.add(strategyIdempotencyKey(projectId, revision, "strategy.competitors", plan.billingMode));
    await enqueue("strategy.competitors", revision, plan.competitors);
  }, [account.userId, blocked, enqueue, getWorkspace, overview, projectId, readError]);

  useEffect(() => {
    if (guided || !overview || readError || pending || blocked) return;
    const current = getWorkspace();
    if (!current || current.conflict) return;
    const applied = overview.jobs.flatMap(job => job.results.map(result => strategyResultApplication(job, result.stepKey)))
      .find(application => application?.inputRevision === current.saved.current_revision);
    if (applied) {
      const key = `${applied.jobId}:${applied.stepKey}:${applied.appliedRevision}`;
      if (!recoveryAttempts.current.has(key)) {
        recoveryAttempts.current.add(key);
        void recoverAppliedVersion(applied.appliedRevision);
      }
      return;
    }
    const intent = readStrategyIntent(account.userId, projectId, current.saved.current_revision - 1);
    if (!intent || !canContinueStrategy(intent, current, overview)) return;
    const plan = strategyIntentPlan(intent);
    if (plan.kind === "response_only") return;
    const key = strategyIdempotencyKey(projectId, current.saved.current_revision, "strategy.competitors", plan.billingMode);
    if (chainAttempts.current.has(key)) return;
    void continueResearch();
  }, [account.userId, blocked, continueResearch, getWorkspace, guided, overview, pending, projectId, readError, recoverAppliedVersion, workspace]);

  const continuationAvailable = !readError && Boolean(overview && canContinueStrategy(readStrategyIntent(account.userId, projectId, workspace.saved.current_revision - 1), workspace, overview));
  const checkStatus = useCallback(() => { recoveryAttempts.current.clear(); refresh(); }, [refresh]);

  return { overview, readError, actionError, pending, pendingLabel, enqueue, retryDelivery, cancel, apply, refresh: checkStatus, report, continueResearch, continuationAvailable };
}
