"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EmbelIdentity } from "@/components/workspace/embel-identity";
import { journeyPartLabel } from "@/domain/journey";
import { z } from "zod";
import { GuidedThinking } from "@/components/workspace/guided-thinking";
import styles from "./naming-chat.module.css";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { namingStrategyKey, type ProjectNameEntry } from "@/domain/project-naming";
import { inlineNamingMessage, NamingApproachWidgets, type InlineNamingConversation } from "./naming-approach-widgets";
import { useNamingFeed } from "./use-naming-feed";
import { NamingFeedResults, NamingFeedStatus } from "./naming-feed-results";
import { NameDetails } from "./name-details";
import { initialNamingView, namingViewNeedsReset, useProjectNaming } from "./use-project-naming";
import { useCustomProjectNames } from "./use-custom-project-names";
import { nameValueSchema, type NamingSource } from "@/domain/naming";

/** Voice · Name inside the project conversation: the choices questions, then the names. */
export function ProjectNamingWorkspace({ projectId, inline }: { projectId: string; inline: InlineNamingConversation }) {
  const { session } = useAccountSession();
  if (!z.uuid().safeParse(projectId).success)
    return inlineNamingMessage(
      inline,
      <p className="project-naming-notice" role="alert">
        This project’s names are not available.
      </p>,
    );
  if (session.status !== "ready") return inlineNamingMessage(inline, <AccountStatus />);
  return (
    <AccountProjectNaming
      key={`${session.userId}:${session.generation}:${projectId}`}
      projectId={projectId}
      account={session}
      inline={inline}
    />
  );
}

const createdOrder = (left: ProjectNameEntry, right: ProjectNameEntry) =>
  Date.parse(left.candidate.createdAt) - Date.parse(right.candidate.createdAt) ||
  left.candidate.id.localeCompare(right.candidate.id);

function AccountProjectNaming({
  projectId,
  account,
  inline,
}: {
  projectId: string;
  account: VerifiedAccount;
  inline: InlineNamingConversation;
}) {
  const { isCurrent } = useAccountSession();
  const naming = useProjectNaming({ account, projectId });
  const custom = useCustomProjectNames(account, projectId);
  const { overview, blocked, pending, readError, actionError } = naming;
  const [earlierChoice, setEarlierChoice] = useState<ProjectNameEntry | null>(null);
  const [acceptedEarlierFor, setAcceptedEarlierFor] = useState<string | null>(null);
  const [previewEntry, setPreviewEntry] = useState<ProjectNameEntry | null>(null);
  const inspectedId = previewEntry?.candidate.id;
  const returnFromInspection = useRef<string | null>(null);
  useLayoutEffect(() => {
    const candidateId = returnFromInspection.current;
    if (inspectedId || !candidateId) return;
    returnFromInspection.current = null;
    if (!isCurrent(account)) return;
    const card = document.getElementById(`project-name-${candidateId}`);
    const target =
      card?.querySelector<HTMLElement>("button[aria-haspopup=dialog], input[type=radio]") ??
      card ??
      document.querySelector<HTMLElement>("[data-naming-results-scroll]");
    target?.focus({ preventScroll: true });
  }, [inspectedId, account, isCurrent]);
  function closeInspection() {
    returnFromInspection.current = inspectedId ?? null;
    setPreviewEntry(null);
  }
  const [explorationStarted, setExplorationStarted] = useState(false);
  // A card (or Choose this name in its details) marks a name; Send in the reply box confirms it.
  const [pendingChoice, setPendingChoice] = useState<string | null>(null);
  const manualNameDraft = useManualProjectNameDraft();
  const feed = useNamingFeed({
    account,
    projectId,
    projectRevision: overview?.project.current_revision,
    enabled: Boolean(overview?.readiness.ready && !blocked && !readError),
  });
  // The conversation has one names list: an earlier saved pane, filter or batch view returns to it once.
  const resetView = useRef(false);
  const viewNeedsReset = Boolean(overview?.session && namingViewNeedsReset(overview.session.viewState));
  useEffect(() => {
    if (!viewNeedsReset || resetView.current || !isCurrent(account)) return;
    resetView.current = true;
    void naming.saveView({
      pane: "results",
      filter: "all",
      query: "",
      visibleBatchId: null,
      workshopCandidateId: null,
    });
  }, [viewNeedsReset, account, isCurrent, naming]);
  const onCanvas = inline.onCanvas;
  useLayoutEffect(() => {
    onCanvas(false);
  }, [onCanvas]);
  if (!overview)
    return inlineNamingMessage(
      inline,
      readError ? (
        <div className="project-naming-notice" role="alert">
          <p>{readError}</p>
          <button type="button" className="text-link" onClick={naming.refresh}>
            Check naming choices
          </button>
        </div>
      ) : (
        <GuidedThinking label="Opening naming choices…" />
      ),
    );
  const { project } = overview;
  const view = overview.session?.viewState ?? initialNamingView;
  const currentSelection = overview.currentSelection;
  // Generated names come from the feed; your own, copied and older workshop names from the saved overview.
  const lookup = new Map<string, ProjectNameEntry>();
  const keep = (entry: ProjectNameEntry) => {
    const old = lookup.get(entry.candidate.id);
    if (!old || old.retention.revision <= entry.retention.revision) lookup.set(entry.candidate.id, entry);
  };
  overview.candidates.items
    .filter((entry) => !["brainstorm", "generated"].includes(entry.candidate.origin.kind))
    .forEach(keep);
  if (currentSelection)
    keep({
      candidate: currentSelection.candidate,
      retention: overview.candidates.items.find((entry) => entry.candidate.id === currentSelection.candidate.id)
        ?.retention ?? {
        ownerId: account.userId,
        projectId,
        candidateId: currentSelection.candidate.id,
        revision: 0,
        favorite: false,
        saved: false,
        updatedAt: null,
      },
    });
  custom.items.forEach(keep);
  feed.entries.forEach((row) => keep(row.entry));
  const names = [...lookup.values()].sort(createdOrder);
  const strategyKey = namingStrategyKey(project.context);
  const run = feed.state?.feed?.run ?? null;
  // Generation has started once; your own names alone do not count, so the last answer still starts it.
  const generating = explorationStarted || feed.entries.length > 0 || Boolean(run || feed.state?.pending);
  const generationUnavailable = feed.state?.feed?.availability.status === "unavailable";
  const inspected = previewEntry && (lookup.get(previewEntry.candidate.id) ?? previewEntry);
  const generated = new Set(feed.entries.map((row) => row.entry.candidate.id));

  async function continueExploration() {
    if (!isCurrent(account)) return false;
    setPreviewEntry(null);
    const started = await feed.start();
    if (started && isCurrent(account)) setExplorationStarted(true);
    return started;
  }
  async function choose(entry: ProjectNameEntry, acknowledged: boolean) {
    if (!isCurrent(account) || blocked) return;
    if (!(await naming.saveView({ scrollCandidateId: entry.candidate.id }))) return;
    if (!(await naming.select(entry, acknowledged))) return;
    setEarlierChoice(null);
    setAcceptedEarlierFor(null);
    setPreviewEntry(null);
  }
  function select(entry: ProjectNameEntry) {
    if (entry.candidate.strategyKey !== strategyKey) {
      setEarlierChoice(entry);
      setAcceptedEarlierFor(null);
      requestAnimationFrame(() => document.getElementById("project-naming-earlier-heading")?.focus());
    } else void choose(entry, false);
  }
  function retain(entry: ProjectNameEntry, field: "favorite" | "saved") {
    return naming.retain(entry, field, custom.acknowledge);
  }
  async function importManualName(source: NamingSource) {
    const saved = await naming.importLocal({ source, capturedContext: project.context }, custom.acknowledge);
    if (saved) await custom.refresh();
    return saved;
  }

  // Once names exist, the names message carries generation status and Add your own name.
  const namesShown = overview.readiness.ready && (generating || names.length > 0 || Boolean(currentSelection));
  const manual = !blocked && (
    <ManualProjectName disabled={pending || blocked} onAdd={importManualName} draft={manualNameDraft} />
  );
  const chosenEntry =
    names.find((entry) => entry.candidate.id === (pendingChoice ?? currentSelection?.candidate.id)) ?? null;
  const confirmName = () => {
    if (!chosenEntry || pending || blocked) return;
    if (chosenEntry.candidate.id === currentSelection?.candidate.id) inline.onNameConfirmed?.();
    else select(chosenEntry);
  };
  const chat = overview.readiness.ready ? (
    <NamingApproachWidgets
      inline={inline}
      nameChoice={
        namesShown && chosenEntry
          ? { name: chosenEntry.candidate.value, onContinue: confirmName, disabled: pending || blocked }
          : null
      }
      manualName={namesShown ? undefined : manual || undefined}
      memory={feed.memory}
      account={account}
      projectId={projectId}
      context={project.context}
      saved={overview.preferences}
      savedChat={view.namingChat}
      onSaveProgress={naming.saveChatProgress}
      blocked={blocked || Boolean(readError)}
      generationUnavailable={generationUnavailable}
      runtimeReady={feed.state?.feed?.availability.status === "available"}
      exploring={generating}
      canSteer={feed.canExplore && feed.entries.length > 0}
      onSteer={feed.steer}
      onCheckSaved={naming.refresh}
      onContinue={continueExploration}
      generationStatus={
        namesShown ? undefined : (
          <div className="naming-generation-status" role="status">
            <NamingFeedStatus feed={feed} blocked={blocked} />
          </div>
        )
      }
    />
  ) : (
    <p className={styles.chatUnavailable}>
      Review Strategy to continue the Naming conversation. Your saved names remain available.
    </p>
  );

  const earlierConfirmation = earlierChoice && (
    <section className="project-naming-stale-choice" aria-label="Earlier strategy confirmation">
      <h2 id="project-naming-earlier-heading" tabIndex={-1}>
        Use {earlierChoice.candidate.value} from an earlier strategy?
      </h2>
      <p>
        The current saved strategy differs from the context used for this name. Choosing it creates a new selection and
        keeps the original history.
      </p>
      <label>
        <input
          type="checkbox"
          checked={acceptedEarlierFor === strategyKey}
          disabled={pending}
          onChange={(event) => setAcceptedEarlierFor(event.target.checked ? strategyKey : null)}
        />
        I have reviewed this name against the current strategy and want to use it.
      </label>
      <div className="project-naming-actions">
        <button
          className="button secondary small"
          type="button"
          disabled={pending}
          onClick={() => {
            setEarlierChoice(null);
            setAcceptedEarlierFor(null);
          }}
        >
          Keep browsing
        </button>
        <button
          className="button primary small"
          type="button"
          disabled={acceptedEarlierFor !== strategyKey || pending || blocked}
          onClick={() => void choose(earlierChoice, true)}
        >
          Use earlier-context name
        </button>
      </div>
    </section>
  );

  const seeds = feed.steeringDraft.candidateIds;
  const inspection = inspected && (
    <NameDetails
      key={inspected.candidate.id}
      account={account}
      entry={inspected}
      chosen={chosenEntry?.candidate.id === inspected.candidate.id}
      earlierContext={inspected.candidate.strategyKey !== strategyKey}
      pending={pending}
      blocked={blocked || Boolean(readError)}
      overlay={inline.overlay}
      onClose={closeInspection}
      onChoose={() => setPendingChoice(inspected.candidate.id)}
      error={actionError ?? readError}
      onRefresh={naming.refresh}
      onSave={() => void retain(inspected, "saved")}
      onFavorite={() => void retain(inspected, "favorite")}
      steeringSelected={seeds.includes(inspected.candidate.id)}
      steeringDisabled={
        blocked || Boolean(feed.state?.pending) || (seeds.length >= 5 && !seeds.includes(inspected.candidate.id))
      }
      onSteering={
        generated.has(inspected.candidate.id)
          ? () =>
              feed.updateSteeringDraft({
                candidateIds: seeds.includes(inspected.candidate.id)
                  ? seeds.filter((id) => id !== inspected.candidate.id)
                  : [...seeds, inspected.candidate.id],
              })
          : undefined
      }
    />
  );
  const writing = feed.status.kind === "active" || feed.status.kind === "starting";
  return (
    <>
      {readError || actionError
        ? inlineNamingMessage(
            inline,
            <div className="project-naming-notice" role="alert">
              <p>{actionError ?? readError}</p>
              <button type="button" className="text-link" onClick={naming.refresh}>
                Check latest version
              </button>
            </div>,
          )
        : null}
      {overview.readiness.ready ? chat : inlineNamingMessage(inline, chat)}
      {namesShown &&
        inlineNamingMessage(
          inline,
          <article className="guided-assistant-message guided-names-message flow-enter" aria-label="Names">
            <EmbelIdentity label={journeyPartLabel("voice", "Name")} />
            <p className="guided-assistant-copy">
              {writing
                ? names.length
                  ? "I’m writing more names. They appear as they’re ready."
                  : "I’m writing names for your brand. They appear as they’re ready."
                : names.length
                  ? "Here are your first names. Save the ones you like and pick one. Tell me what you like about them and I’ll steer the next ones. When you’ve picked, press Send to continue to Slogan."
                  : "Names appear as they’re ready."}
            </p>
            <div className={styles.namesStatus} aria-live="polite" aria-atomic="true">
              <NamingFeedStatus feed={feed} blocked={blocked || Boolean(readError)} />
            </div>
            {earlierConfirmation}
            {custom.error && (
              <div className="project-naming-notice" role="alert">
                <p>Your own names could not be refreshed. Names already saved are kept.</p>
                <button type="button" className="text-link" onClick={() => void custom.refresh()}>
                  Check your names
                </button>
              </div>
            )}
          </article>,
        )}
      {namesShown &&
        inline.results &&
        createPortal(
          <NamingFeedResults
            entries={names}
            feed={feed}
            selectedId={chosenEntry?.candidate.id}
            strategyKey={strategyKey}
            pending={pending}
            blocked={blocked || Boolean(readError)}
            onRetain={(entry, field) => void retain(entry, field)}
            onSelect={(entry) => setPendingChoice(entry.candidate.id)}
            onInspect={setPreviewEntry}
            manual={manual || undefined}
          />,
          inline.results,
        )}
      <NameChoiceReport
        choice={
          namesShown && chosenEntry
            ? {
                candidateId: chosenEntry.candidate.id,
                name: chosenEntry.candidate.value,
                current: chosenEntry.candidate.id === currentSelection?.candidate.id,
              }
            : null
        }
        onChoice={inline.onNameChoice}
      />
      {inspection}
    </>
  );
}

/** Tells the Workspace which name is chosen, only when that changes. */
function NameChoiceReport({
  choice,
  onChoice,
}: {
  choice: { candidateId: string; name: string; current: boolean } | null;
  onChoice?: InlineNamingConversation["onNameChoice"];
}) {
  const report = useRef(onChoice);
  useLayoutEffect(() => {
    report.current = onChoice;
  });
  const { candidateId, name, current } = choice ?? {};
  useEffect(() => {
    report.current?.(candidateId && name ? { candidateId, name, current: Boolean(current) } : null);
  }, [candidateId, name, current]);
  useEffect(() => () => report.current?.(null), []);
  return null;
}

function useManualProjectNameDraft() {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState<NamingSource | null>(null);
  const lockRef = useRef(false);
  return { value, setValue, saving, setSaving, error, setError, intent, setIntent, lockRef };
}

export function ManualProjectName({
  disabled,
  onAdd,
  draft,
}: {
  disabled: boolean;
  onAdd: (source: NamingSource) => Promise<boolean>;
  draft?: ReturnType<typeof useManualProjectNameDraft>;
}) {
  const localDraft = useManualProjectNameDraft();
  const { value, setValue, saving, setSaving, error, setError, intent, setIntent, lockRef } = draft ?? localDraft;
  async function submit() {
    if (disabled || lockRef.current) return;
    const parsed = nameValueSchema.safeParse(value);
    if (!parsed.success) {
      setError("Enter a visible name of up to 160 characters.");
      return;
    }
    const source = intent ?? {
      id: crypto.randomUUID(),
      value: parsed.data,
      createdAt: new Date().toISOString(),
      origin: "manual",
      history: [],
    };
    setIntent(source);
    lockRef.current = true;
    setSaving(true);
    setError(null);
    try {
      if (await onAdd(source)) {
        setIntent(null);
        setValue("");
      } else setError("This save could not be confirmed. Retry the same name to check it safely.");
    } catch {
      setError("This save could not be confirmed. Retry the same name to check it safely.");
    } finally {
      lockRef.current = false;
      setSaving(false);
    }
  }
  return (
    <form
      className={styles.manualName}
      aria-label="Add your own name"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label>
        Your own name
        <input
          value={value}
          maxLength={160}
          disabled={disabled || saving || Boolean(intent)}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          placeholder="Enter a name you have in mind"
        />
      </label>
      <button className="button secondary small" type="submit" disabled={disabled || saving || !value.trim()}>
        {saving ? "Saving name…" : intent ? "Retry saving name" : "Add name"}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
