"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState, LoadingRegion, Skeleton } from "@/components/ui/feedback";
import { InlineMessage } from "@/components/ui/message";
import { logoUuidSchema } from "@/domain/logo-vector";
import type { IdentityBatchState } from "@/domain/identity-jobs";
import { getIdentityFreshness } from "@/domain/project-identity";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { useProjectIdentity } from "@/components/identity/use-project-identity";
import { useLogoDraftMemory } from "@/components/identity/logo-draft-memory-context";
import { useLogoWorkspace } from "@/components/identity/use-logo-workspace";
import { BrandAssetsPanel } from "@/features/brand-assets/components/brand-assets-panel";
import { describeVisualDirections } from "./direction-presentation";
import { accountProjectResponseSchema } from "@/domain/project-api";
import type { ContextSnapshot } from "@/domain/projects";
import { boundedAccountRequest } from "@/components/workspace/bounded-account-request";

export function BrandAssetsPage({ projectId }: { projectId: string }) {
  const { session } = useAccountSession();
  if (!logoUuidSchema.safeParse(projectId).success)
    return (
      <section className="e-container e-page">
        <EmptyState
          danger
          headingLevel={1}
          icon="circle-alert"
          title="Project not found"
          action={<ButtonLink href="/brands">Back to projects</ButtonLink>}
        />
      </section>
    );
  return (
    <section className="e-container e-page" aria-label="Assets">
      <AccountStatus />
      {session.status === "ready" && (
        <OwnedBrandAssets
          key={`${session.userId}:${session.generation}:${projectId}`}
          account={session}
          projectId={projectId}
        />
      )}
    </section>
  );
}

function OwnedBrandAssets({ account, projectId }: { account: VerifiedAccount; projectId: string }) {
  const { isCurrent } = useAccountSession(),
    memory = useLogoDraftMemory();
  const identity = useProjectIdentity(projectId, undefined, { logoDirections: true });
  const logo = useLogoWorkspace({ projectId, memory });
  const { client } = identity;
  const system = identity.checked ? (identity.overview?.currentSelection?.system ?? null) : null;
  const batchId = system?.source.kind === "generated" ? system.source.batchId : null;
  const [check, setCheck] = useState<{
    client: typeof client;
    batchId: string;
    attempt: number;
    batch: IdentityBatchState | null;
    error: string | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The saved project supplies the guidelines' positioning, audience, competitors and slogan.
  const [project, setProject] = useState<{ projectId: string; context: ContextSnapshot } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void boundedAccountRequest(`/api/projects/${projectId}`, accountProjectResponseSchema, {
      signal: controller.signal,
    })
      .then(({ project: saved }) => {
        if (!controller.signal.aborted && saved.owner_id === account.userId && saved.id === projectId)
          setProject({ projectId, context: saved.context });
      })
      .catch(() => {
        /* The kit still opens; the guidelines leave out what could not be read. */
      });
    return () => controller.abort();
  }, [account.userId, projectId]);
  useEffect(() => {
    if (!client || !batchId || !client.current() || !isCurrent(account)) return;
    const controller = new AbortController();
    let active = true;
    const finish = (batch: IdentityBatchState | null, error: string | null) => {
      if (!active) return;
      active = false;
      clearTimeout(timeout);
      if (client.current() && isCurrent(account)) setCheck({ client, batchId, attempt, batch, error });
    };
    const timeout = setTimeout(() => {
      // Settle even if a stalled response does not acknowledge cancellation.
      finish(null, "The saved direction took too long to load. Please try again. Your files are kept.");
      controller.abort();
    }, 30_000);
    void client.batch(batchId, controller.signal).then(
      (batch) => finish(batch, batch ? null : "The saved direction could not be checked."),
      () => finish(null, "The saved direction could not be checked. Your files are kept."),
    );
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [client, batchId, attempt, account, isCurrent]);
  const checked = check?.client === client && check.batchId === batchId && check.attempt === attempt ? check : null;
  const batch = checked?.batch,
    sourceLogo = batch?.sourceLogo;
  const sourceMatches = Boolean(
    batch?.sourceLogoCurrent &&
    sourceLogo &&
    system &&
    batch.systems.some(
      (saved) =>
        saved.id === system.id &&
        saved.board.asset.versionId === system.board.asset.versionId &&
        saved.board.asset.contentHash === system.board.asset.contentHash,
    ),
  );
  const fresh =
    system && identity.overview
      ? getIdentityFreshness(system.input.basis, identity.overview.currentBasis).status === "current"
      : false;
  const revalidate = useCallback(
    async (signal: AbortSignal) => {
      if (!client?.current() || !system || !sourceLogo || !batchId) return false;
      const [overview, savedBatch] = await Promise.all([client.overview({}, signal), client.batch(batchId, signal)]);
      return Boolean(
        !signal.aborted &&
        client.current() &&
        overview?.currentSelection?.system.id === system.id &&
        savedBatch?.sourceLogoCurrent &&
        JSON.stringify(savedBatch.sourceLogo) === JSON.stringify(sourceLogo) &&
        savedBatch.systems.some((saved) => JSON.stringify(saved) === JSON.stringify(system)) &&
        JSON.stringify(overview.currentSelection.system) === JSON.stringify(system) &&
        getIdentityFreshness(system.input.basis, overview.currentBasis).status === "current",
      );
    },
    [client, system, sourceLogo, batchId],
  );

  if (!isCurrent(account)) return null;
  const waiting = (text: string) => (
    <div className="e-stack e-stack--lg">
      <h1 className="e-sr">Assets</h1>
      <LoadingRegion label={text}>
        <Skeleton shape="title" width={40} />
      </LoadingRegion>
      <p className="e-section__hint">{text}</p>
    </div>
  );
  if (identity.error || checked?.error || logo.error)
    return (
      <div className="e-stack e-stack--lg">
        <h1 className="e-sr">Assets</h1>
        <InlineMessage
          tone="danger"
          actions={
            <Button
              size="sm"
              icon="rotate-ccw"
              onClick={() => {
                void identity.refresh();
                void logo.reload(false);
                setAttempt((value) => value + 1);
              }}
            >
              Check saved direction
            </Button>
          }
        >
          {identity.error ?? checked?.error ?? logo.error}
        </InlineMessage>
      </div>
    );
  if (!identity.checked || identity.loading || logo.status === "loading" || (batchId && !checked))
    return waiting("Loading your chosen direction…");
  if (!system || !batchId || !sourceLogo || !sourceMatches || !fresh)
    return (
      <EmptyState
        headingLevel={1}
        icon="palette"
        title={system ? "Choose a current creative direction" : "Choose your creative direction first"}
        text={
          system
            ? "Your saved direction uses earlier inputs. Return to Creative direction to choose a board built around your current logo."
            : "Compare the three boards, then choose one to create your brand assets."
        }
        action={
          <ButtonLink variant="primary" href={`/brands/account/${projectId}/logo/directions`}>
            Choose a creative direction
          </ButtonLink>
        }
      />
    );
  if (!client || !logo.client || logo.workspace?.ownerId !== account.userId || logo.workspace.projectId !== projectId)
    return waiting("Checking your saved logo…");
  if (identity.strategyDirty || identity.preferencesDirty || logo.dirty || logo.pending)
    return (
      <div className="e-stack e-stack--lg">
        <h1 className="e-sr">Assets</h1>
        <InlineMessage tone="warning" live>
          Save or resolve your changes before opening the kit. Your chosen direction is kept.
        </InlineMessage>
      </div>
    );
  const directionTitle = describeVisualDirections(batch.systems).find((direction) => direction.id === system.id)?.title;
  return (
    <BrandAssetsPanel
      key={`${system.id}:${sourceLogo.preview.reference.versionId}`}
      system={system}
      sourceLogo={sourceLogo}
      identityClient={client}
      logoClient={logo.client}
      account={account}
      projectId={projectId}
      revalidate={revalidate}
      directionTitle={directionTitle}
      onRefreshSelection={() => {
        void identity.refresh();
        void logo.reload(false);
        setAttempt((value) => value + 1);
      }}
      vectorRevisionId={logo.workspace.approvedLogo?.vectorRevisionId ?? null}
      context={project?.projectId === projectId ? project.context : null}
    />
  );
}
