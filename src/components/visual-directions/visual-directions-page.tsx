"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useProjectProgress } from "@/components/workspace/project-progress";
import { logoUuidSchema } from "@/domain/logo-vector";
import {
  logoBoardGenerationIntentSchema,
  type IdentityAvailability,
  type IdentityBatchState,
} from "@/domain/identity-jobs";
import { getIdentityFreshness, type IdentitySystemVersion } from "@/domain/project-identity";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { useProjectIdentity } from "@/components/identity/use-project-identity";
import { IdentitySystemBoard } from "@/components/identity/identity-system-board";
import { identityBatchUnresolved } from "@/components/identity/identity-generation-controller";
import { useLogoDraftMemory } from "@/components/identity/logo-draft-memory-context";
import { useLogoWorkspace } from "@/components/identity/use-logo-workspace";
import { useLogoCandidate } from "@/components/logo-creation/use-logo-candidate";
import { logoCandidateKey } from "@/components/logo-creation/candidate-review";
import { LogoVerifiedPreview, useVerifiedPreview } from "@/components/logo-creation/verified-preview";
import { describeVisualDirections } from "./direction-presentation";
import { hasCurrentBrandAssets } from "./selected-assets";
import stage from "@/styles/branding-stage.module.css";
import { Button, ButtonLink } from "@/components/ui/button";
import { runWithCreditsInPlace } from "@/components/billing/out-of-credits";
import { NoCreditsNote, OutOfCreditsInPlace, useCreditBalance } from "@/components/logo-creation/credits-in-place";
import type { StepReply } from "@/features/logo-creation/model/step-reply";
import { useStepReply } from "@/features/logo-creation/use-step-reply";
import { createPortal } from "react-dom";
import { InlineMessage } from "@/components/ui/message";
import {
  useWorkspaceChatSlot,
  useWorkspaceStepAnswer,
  useWorkspaceStepMessage,
} from "@/components/workspace/workspace-slots";
import { chosenLogoAnswer, useChosenLogoLabel } from "@/components/logo-creation/chosen-logo-label";
import {
  ChosenBrandView,
  VisualDirectionsView,
  type VisualDirectionCard,
  type VisualDirectionGeneration,
} from "./visual-directions-view";

/** Chosen from the click (D-058): while a choice saves, the board being chosen shows as chosen and the saved one does
 * not; if saving fails, `choosing` clears and the saved choice shows again. */
export function shownAsChosen(choosing: string | null, savedId: string | undefined, id: string) {
  return choosing ? choosing === id : savedId === id;
}

export function VisualDirectionsPage({
  projectId,
  variant = "page",
  presentation = "choose",
  reply = "inline",
  onReplyChange,
}: {
  projectId: string;
  variant?: "page" | "conversation";
  /** "brand": a finished brand shows "Your brand" (the chosen board large and the chosen logo) instead of the three
   * boards, once a direction is chosen. */
  presentation?: "choose" | "brand";
  /** "external": a Send-driven reply box (the Workspace chat) moves the step on. See `StepReply`. */
  reply?: "inline" | "external";
  /** The step's reply-box state: the chosen direction as a chip, and Send continuing to Assets. */
  onReplyChange?: (reply: StepReply | null) => void;
}) {
  const { session } = useAccountSession();
  const router = useRouter(),
    progress = useProjectProgress();
  // A complete brand shows Creative direction in its project conversation, after
  // the Logo step; this page stays for projects without that conversation.
  const moved = variant === "page" && progress?.projectId === projectId;
  useEffect(() => {
    if (moved) router.replace(`/brands/account/${projectId}?view=strategy#journey-directions`);
  }, [moved, projectId, router]);
  if (!logoUuidSchema.safeParse(projectId).success)
    return variant === "conversation" ? null : (
      <section className={stage.frame}>
        <h1 className={stage.title}>Project not found</h1>
        <Link className={stage.actionLink} href="/brands">
          Back to projects
        </Link>
      </section>
    );
  if (moved) return null;
  const owned = session.status === "ready" && (
    <OwnedVisualDirections
      key={`${session.userId}:${session.generation}:${projectId}`}
      account={session}
      projectId={projectId}
      variant={variant}
      presentation={presentation}
      reply={reply}
      onReplyChange={onReplyChange}
    />
  );
  return variant === "conversation" ? (
    owned || null
  ) : (
    <>
      <AccountStatus />
      {owned}
    </>
  );
}

function availabilityReason(availability: IdentityAvailability | undefined) {
  if (!availability) return "Getting your directions ready…";
  if (availability.status === "available")
    return availability.version === 3 ? null : "Creative direction is being updated. Check again shortly.";
  switch (availability.reason) {
    case "logo_selection_required":
      return "Choose a logo concept first.";
    case "logo_needs_review":
      return "Your logo uses earlier inputs. Review your concept choice before generating directions.";
    case "inputs_not_ready":
      return "Finish your saved brief and brand name before generating directions.";
    case "unsupported_brand_text":
      return "Some characters in your name cannot yet be rendered in downloadable brand assets. Update the name in your logo brief before generating directions.";
    case "reference_limit_exceeded":
      return "Use up to three inspiration images alongside your chosen logo.";
    case "reference_bytes_exceeded":
      return "Your chosen logo and inspiration images are too large together. Remove a reference image and try again.";
    case "references_unavailable":
      return "An inspiration image could not be verified. Check your saved references.";
    default:
      return "Generation is temporarily unavailable. Your saved work is kept.";
  }
}
function progressStatus(batch: IdentityBatchState | null): VisualDirectionGeneration["status"] {
  if (!batch) return "idle";
  return batch.status === "succeeded"
    ? "complete"
    : batch.status === "needs_reconciliation"
      ? "uncertain"
      : batch.status === "cancel_requested"
        ? "stopping"
        : batch.status;
}

function OwnedVisualDirections({
  account,
  projectId,
  variant,
  presentation,
  reply,
  onReplyChange,
}: {
  account: VerifiedAccount;
  projectId: string;
  variant: "page" | "conversation";
  presentation: "choose" | "brand";
  reply: "inline" | "external";
  onReplyChange?: (reply: StepReply | null) => void;
}) {
  const router = useRouter();
  // Credits are shown, never money: at 0 the step marks it before the click (D-014); a start refused for lack of
  // credits shows the Out-of-credits message here instead of the app-wide prompt (D-015). The server decides.
  const credits = useCreditBalance(account);
  const [ranOut, setRanOut] = useState(false);
  const { isCurrent } = useAccountSession(),
    memory = useLogoDraftMemory();
  const logo = useLogoWorkspace({ projectId, memory });
  const identity = useProjectIdentity(projectId, undefined, { logoDirections: true });
  const { client, generation } = identity;
  const ownedLogo =
    isCurrent(account) && logo.workspace?.ownerId === account.userId && logo.workspace.projectId === projectId;
  const source = ownedLogo ? (logo.stagePayloads?.concepts?.payload.selected ?? null) : null;
  const candidate = useLogoCandidate(ownedLogo ? logo.client : null, account, projectId, source);
  const [history, setHistory] = useState<{
    client: typeof client;
    batch: IdentityBatchState | null;
    busy: boolean;
    error: string | null;
  } | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  // The chosen board's verified preview, for the small copy in the folded Creative direction entry.
  const [chosenBoard, setChosenBoard] = useState<{ id: string; url: string | null } | null>(null);
  const historyRequest = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      historyRequest.current?.abort();
      historyRequest.current = null;
    },
    [client],
  );
  const shownHistory = history?.client === client ? history : null;
  const batch = shownHistory?.batch ?? generation.batch ?? generation.overview?.latest ?? null;
  const availability = generation.overview?.availability;
  const currentBatch = Boolean(
    batch?.sourceLogo &&
    batch.sourceLogoCurrent &&
    source &&
    logoCandidateKey(batch.sourceLogo.source) === logoCandidateKey(source),
  );
  const selection = identity.checked && !identity.selectionUncertain ? identity.overview?.currentSelection : null;
  const selectedSystem = selection?.system;
  const logoPending = !ownedLogo || !logo.client || logo.pending || logo.dirty || Boolean(logo.draft?.conflict);
  const blockedReason =
    availabilityReason(availability) ??
    (logoPending ? "Wait for your logo changes to save before continuing." : identity.generationBlockedReason);
  const unresolved = Boolean(
    generation.retained ||
    identityBatchUnresolved(generation.batch) ||
    identityBatchUnresolved(generation.overview?.latest ?? null),
  );

  async function refresh() {
    await Promise.allSettled([identity.refresh(), logo.reload(false), generation.controller?.refresh()]);
    if (shownHistory?.batch) await viewBatch(shownHistory.batch.batchId);
  }
  async function viewBatch(batchId: string) {
    if (!client?.current() || historyRequest.current) return;
    const controller = new AbortController();
    historyRequest.current = controller;
    setHistory({ client, batch: shownHistory?.batch ?? null, busy: true, error: null });
    try {
      const result = await client.batch(batchId, controller.signal);
      if (!controller.signal.aborted && client.current())
        setHistory({
          client,
          batch: result ?? shownHistory?.batch ?? null,
          busy: false,
          error: result ? null : "This saved set could not be loaded. Please try again.",
        });
    } catch {
      if (!controller.signal.aborted && client.current())
        setHistory({
          client,
          batch: shownHistory?.batch ?? null,
          busy: false,
          error: "This saved set could not be loaded. Please try again.",
        });
    } finally {
      if (historyRequest.current === controller) historyRequest.current = null;
    }
  }
  function start() {
    if (
      !client?.current() ||
      blockedReason ||
      unresolved ||
      availability?.status !== "available" ||
      availability.version !== 3
    )
      return;
    const input = logoBoardGenerationIntentSchema.parse({
      version: 3,
      spendControl: "uncapped",
      expectedProjectRevision: availability.expectedProjectRevision,
      expectedReferenceRevision: availability.expectedReferenceRevision,
      expectedPreferencesRevision: availability.expectedPreferencesRevision,
      expectedIdentityRevision: availability.expectedIdentityRevision,
      expectedLogoRevision: availability.expectedLogoRevision,
      sourceLogo: availability.sourceLogo.source,
      idempotencyKey: crypto.randomUUID(),
      acceptedPolicyIdentity: availability.policyIdentity,
    });
    historyRequest.current?.abort();
    historyRequest.current = null;
    setHistory(null);
    setRanOut(false);
    const controller = generation.controller;
    if (!controller) return;
    void runWithCreditsInPlace(() => controller.start(input)).then(({ outOfCredits }) => {
      credits.refresh();
      if (outOfCredits) setRanOut(true);
    });
  }
  // Creative direction starts once on arrival with a newly chosen logo: the
  // Continue click on the logo step is the deliberate request. One marker per
  // project and logo keeps a reload or a return visit from starting another set.
  const latest = generation.overview?.latest ?? null;
  const logoKey =
    availability?.status === "available" && availability.version === 3
      ? logoCandidateKey(availability.sourceLogo.source)
      : null;
  const latestForLogo = Boolean(
    logoKey && latest?.sourceLogo && logoCandidateKey(latest.sourceLogo.source) === logoKey,
  );
  const autoStart = useEffectEvent(() => {
    if (
      !logoKey ||
      latestForLogo ||
      shownHistory ||
      unresolved ||
      blockedReason ||
      generation.busy ||
      !generation.overview ||
      !identity.checked
    )
      return;
    // Only right after Continue on the chosen logo (a deliberate click within the
    // last ten minutes); opening this page any other way waits for a click.
    const intentKey = `embel.directions-intent.v1:${projectId}`,
      marker = `embel.auto-directions.v1:${projectId}:${logoKey}`;
    try {
      const intent = Number(window.sessionStorage.getItem(intentKey));
      window.sessionStorage.removeItem(intentKey);
      if (!intent || Date.now() - intent > 600_000 || window.sessionStorage.getItem(marker)) return;
      window.sessionStorage.setItem(marker, "1");
    } catch {
      return;
    }
    start();
  });
  // The start itself clears a viewed earlier set; that is the intended reaction.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    autoStart();
  }, [logoKey, latestForLogo, unresolved, blockedReason, generation.busy, generation.overview, identity.checked]);
  async function choose(system: IdentitySystemVersion) {
    if (
      !client?.current() ||
      choosing ||
      identity.blocked ||
      logoPending ||
      !currentBatch ||
      !identity.overview ||
      getIdentityFreshness(system.input.basis, identity.overview.currentBasis).status !== "current"
    )
      return;
    setChoosing(system.id);
    try {
      await identity.chooseSystem(false, system);
      if (client.current()) await generation.controller?.refresh();
    } finally {
      if (client.current()) setChoosing(null);
    }
  }
  const visible = Boolean(isCurrent(account) && identity.verified && identity.verified.userId === account.userId);
  const descriptions = describeVisualDirections(batch?.systems ?? []);
  const cards = [0, 1, 2].map((index) => {
    const system = batch?.systems[index];
    const description = descriptions[index];
    if (!system || !description || !client) return null;
    // Missing or still-loading observations block choosing; they do not prove
    // that saved boards are stale or require another generation.
    const stale =
      (!logoPending && !currentBatch) ||
      Boolean(
        identity.overview &&
        getIdentityFreshness(system.input.basis, identity.overview.currentBasis).status !== "current",
      );
    return {
      ...description,
      preview: (
        <IdentitySystemBoard
          board={system.board}
          name={system.input.basis.name}
          client={client}
          onUrl={selectedSystem?.id === system.id ? (url) => setChosenBoard({ id: system.id, url }) : undefined}
        />
      ),
      selected: shownAsChosen(choosing, selectedSystem?.id, system.id),
      stale,
      pending: choosing === system.id,
      disabledReason: stale
        ? "This board uses earlier inputs. Generate a new set with your current logo."
        : logoPending
          ? "Wait for your logo changes to save."
          : (identity.selectionBlockedReason ?? undefined),
      // While a choice saves, the other boards wait without a note inserted under each of them (D-057).
      onChoose: choosing ? undefined : () => void choose(system),
    };
  }) as [VisualDirectionCard | null, VisualDirectionCard | null, VisualDirectionCard | null];
  const earlierSets = [
    ...new Set(
      (identity.items ?? []).flatMap((item) => (item.source.kind === "generated" ? [item.source.batchId] : [])),
    ),
  ];
  const selectedBatchId = selectedSystem?.source.kind === "generated" ? selectedSystem.source.batchId : null;
  const requestBatch = generation.batch ?? generation.overview?.latest ?? batch;
  const visibleStatus = generation.retained ? "uncertain" : progressStatus(requestBatch);
  const brandName =
    logo.stagePayloads?.brief_references?.payload.name ??
    (identity.overview?.currentBasis.status === "available" ? identity.overview.currentBasis.basis.name : "Your brand");
  const showAssets =
    !choosing &&
    !identity.pending &&
    !logoPending &&
    !identity.strategyDirty &&
    !identity.preferencesDirty &&
    !identity.referencesPending &&
    hasCurrentBrandAssets(selection, source);
  const chosenTitle =
    descriptions.find((description) => description.id === selectedSystem?.id)?.title ??
    (selectedSystem ? describeVisualDirections([selectedSystem])[0]?.title : undefined);
  const assetsHref = `/brands/account/${projectId}/logo/deliverables`;
  const noCredits = credits.balance !== null && credits.balance <= 0;
  // The reply box (decision 2): the chosen direction as a chip; Send continues to Assets.
  const brandShown = presentation === "brand" && showAssets && Boolean(selectedSystem && chosenTitle && client);
  const stepReply: StepReply | null = visible
    ? {
        step: "direction",
        // A finished brand shows the brand itself; its reply box holds no chip.
        chips:
          chosenTitle && showAssets && !brandShown ? [{ id: "direction", label: `Direction: ${chosenTitle}` }] : [],
        placeholder: brandShown
          ? "Describe a change, or press Send to continue…"
          : showAssets
            ? "Press Send to continue to Assets…"
            : "Choose a direction, then press Send…",
        sendLabel: "Continue to Assets",
        canSend: showAssets && !unresolved,
        acceptsText: false,
        outOfCredits: false,
        working: unresolved,
        stopLabel: "Stop drawing",
        send: () => {
          if (showAssets) router.push(assetsHref);
        },
        stop:
          unresolved && generation.stopAcknowledgedBatchId !== generation.batch?.batchId
            ? () => {
                if (generation.retained) void generation.controller?.closeOriginal();
                else void generation.controller?.stop();
              }
            : undefined,
      }
    : null;
  useStepReply(stepReply, onReplyChange);

  // In the Workspace the chat talks and the work area shows only the work: Embel's message for this state and the
  // step's status (progress, a failure with Try again, credits in place) sit in the chat.
  const chatSlot = useWorkspaceChatSlot();
  const inChat = reply === "external" && Boolean(chatSlot);
  const shownError = ranOut ? null : (generation.error ?? identity.error ?? logo.error ?? shownHistory?.error ?? null);
  const comparing = cards.some(Boolean);
  const drawFailed = !comparing && !unresolved && visibleStatus === "failed";
  const stepMessage =
    !visible || brandShown
      ? null
      : unresolved
        ? `I’m drawing three directions for ${brandName}. They appear on the right as each one is ready.`
        : drawFailed || (shownError && !comparing)
          ? ""
          : showAssets && chosenTitle
            ? `${chosenTitle} is your direction. Your brand assets are made from it. To change it, choose another board. When you’re happy with it, press Send to continue to Assets.`
            : comparing
              ? `Here are three directions for ${brandName}. Each board shows colors, type and example uses. Choose the one that feels right.`
              : `I’ll draw three directions for ${brandName}, each built on your chosen logo.`;
  useWorkspaceStepMessage("directions", inChat ? stepMessage : null);
  // The folded Logo and Creative direction entries: the chosen logo and direction, each with a small copy.
  const logoLabel = useChosenLogoLabel(inChat ? logo.client : null, account, projectId, source);
  const logoPicture = useVerifiedPreview(
    inChat ? logo.client : null,
    inChat ? (candidate.item?.preview ?? null) : null,
  );
  useWorkspaceStepAnswer(
    "logo",
    logoLabel ? chosenLogoAnswer(logoLabel) : null,
    logoPicture.failed ? null : { url: logoPicture.url, alt: "Chosen logo concept" },
  );
  useWorkspaceStepAnswer(
    "directions",
    inChat && showAssets && chosenTitle ? chosenTitle : null,
    selectedSystem
      ? { url: chosenBoard?.id === selectedSystem.id ? chosenBoard.url : null, alt: `${chosenTitle} board` }
      : null,
  );
  const stopping = visibleStatus === "stopping";
  const chatStatus =
    inChat && chatSlot && visible
      ? createPortal(
          <div className="e-stack e-stack--sm" data-step-status="directions">
            {unresolved && (
              <div className="e-stack e-stack--sm conversation-progress" role="status">
                <p className="e-turn__text">
                  {stopping ? "Stopping…" : "Drawing three directions. This usually takes a few minutes."}
                </p>
                <div className="e-progress" data-state={stopping ? "stopping" : "running"} aria-hidden="true">
                  <div className="e-progress__track" />
                </div>
              </div>
            )}
            {ranOut ? (
              <OutOfCreditsInPlace periodEnd={credits.periodEnd} onDismiss={() => setRanOut(false)} />
            ) : drawFailed || shownError ? (
              <InlineMessage
                tone="danger"
                live={false}
                title={drawFailed ? "The three directions couldn’t be drawn" : undefined}
                actions={
                  drawFailed && !blockedReason && !noCredits ? (
                    <Button variant="primary" icon="rotate-ccw" disabled={Boolean(generation.busy)} onClick={start}>
                      Try again
                    </Button>
                  ) : (
                    <Button icon="refresh-cw" disabled={Boolean(generation.busy)} onClick={() => void refresh()}>
                      Check availability
                    </Button>
                  )
                }
              >
                {drawFailed ? (shownError ?? "Your logo and your earlier answers are saved.") : shownError}
              </InlineMessage>
            ) : noCredits && !brandShown ? (
              <NoCreditsNote periodEnd={credits.periodEnd} />
            ) : null}
          </div>,
          chatSlot,
        )
      : null;
  if (!visible) return null;
  if (brandShown && selectedSystem && chosenTitle && client) {
    const board = (
      <IdentitySystemBoard
        board={selectedSystem.board}
        name={selectedSystem.input.basis.name}
        client={client}
        onUrl={(url) => setChosenBoard({ id: selectedSystem.id, url })}
      />
    );
    return (
      <>
        {chatStatus}
        <ChosenBrandView
          title={chosenTitle}
          board={board}
          enlarged={
            <IdentitySystemBoard board={selectedSystem.board} name={selectedSystem.input.basis.name} client={client} />
          }
          logo={{ url: logoPicture.url, failed: logoPicture.failed, label: logoLabel && chosenLogoAnswer(logoLabel) }}
        />
      </>
    );
  }
  return (
    <>
      {chatStatus}
      <VisualDirectionsView
        brandName={brandName}
        variant={variant}
        // In the conversation the Logo step is right above.
        backHref={variant === "page" ? `/brands/account/${projectId}/logo` : undefined}
        logoPreview={
          candidate.item && logo.client ? (
            <LogoVerifiedPreview client={logo.client} receipt={candidate.item.preview} alt="Chosen logo concept" />
          ) : (
            <p role="status">
              {candidate.error || logo.error
                ? "Your selected logo could not be loaded."
                : candidate.loading
                  ? "Loading your chosen logo…"
                  : "Choose a logo concept to begin."}
            </p>
          )
        }
        cards={cards}
        reply={reply}
        creditsNotice={
          inChat ? null : ranOut ? (
            <OutOfCreditsInPlace periodEnd={credits.periodEnd} onDismiss={() => setRanOut(false)} />
          ) : noCredits ? (
            <NoCreditsNote periodEnd={credits.periodEnd} />
          ) : null
        }
        generation={{
          status: visibleStatus,
          completed: requestBatch?.systems.length ?? 0,
          // Amounts stay on the Usage page; the journey shows no money (2026-11-06).
          usageLabel: null,
          // A refusal for lack of credits is told once, in place, by the Out-of-credits message.
          error: inChat ? null : shownError,
          busy: Boolean(generation.busy || shownHistory?.busy),
          disabledReason: blockedReason,
          // At 0 credits More directions is unavailable before the click; the no-credits note says why (D-015).
          onGenerate: noCredits ? undefined : start,
          onCheck: () => void refresh(),
          onStop:
            unresolved && generation.stopAcknowledgedBatchId !== generation.batch?.batchId
              ? () => {
                  if (generation.retained) void generation.controller?.closeOriginal();
                  else void generation.controller?.stop();
                }
              : undefined,
        }}
        selectionCheck={
          identity.selectionCheckAvailable
            ? { busy: identity.loading || identity.detailLoading, onCheck: () => void identity.refresh() }
            : undefined
        }
        selectionStatus={
          showAssets ? (chosenTitle ? `${chosenTitle} chosen` : "Your chosen direction is in an earlier set") : null
        }
        selectionError={
          identity.selectionUncertain
            ? "Your choice could not be confirmed. Use Check saved choice before choosing again."
            : null
        }
        finalAction={
          showAssets && (
            <ButtonLink variant="primary" href={assetsHref}>
              Continue
            </ButtonLink>
          )
        }
        history={
          <>
            {shownHistory?.batch && shownHistory.batch.batchId !== requestBatch?.batchId && (
              <p>You are viewing an earlier saved set. The progress above is for your latest request.</p>
            )}
            {generation.retained && generation.lookup === "not_found" && (
              <Button
                size="sm"
                disabled={Boolean(generation.busy)}
                onClick={() => void generation.controller?.retryOriginal()}
              >
                Retry original request
              </Button>
            )}
            {selectedBatchId && selectedBatchId !== batch?.batchId && (
              <p>
                Your chosen direction is in an earlier set.{" "}
                <button
                  type="button"
                  className="e-link"
                  disabled={Boolean(shownHistory?.busy)}
                  onClick={() => void viewBatch(selectedBatchId)}
                >
                  View chosen direction
                </button>
              </p>
            )}
            {earlierSets.length > 1 && (
              <details>
                <summary>Earlier sets</summary>
                {earlierSets.map((batchId, index) => (
                  <Button
                    key={batchId}
                    size="sm"
                    disabled={batch?.batchId === batchId || Boolean(shownHistory?.busy)}
                    onClick={() => void viewBatch(batchId)}
                  >
                    Saved set {earlierSets.length - index}
                  </Button>
                ))}
                {identity.nextCursor && (
                  <button
                    className="e-link"
                    type="button"
                    disabled={identity.loadingMore}
                    onClick={() => void identity.loadMore()}
                  >
                    Show older sets
                  </button>
                )}
              </details>
            )}
          </>
        }
      />
    </>
  );
}
