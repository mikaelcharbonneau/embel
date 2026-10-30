"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { logoUuidSchema } from "@/domain/logo-vector";
import type { IdentityBatchState } from "@/domain/identity-jobs";
import { getIdentityFreshness } from "@/domain/project-identity";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { useProjectIdentity } from "@/components/identity/use-project-identity";
import { useLogoDraftMemory } from "@/components/identity/logo-draft-memory-context";
import { useLogoWorkspace } from "@/components/identity/use-logo-workspace";
import { BrandAssetsPanel } from "@/features/brand-assets/components/brand-assets-panel";

export function BrandAssetsPage({ projectId }: { projectId: string }) {
  const { session } = useAccountSession();
  if (!logoUuidSchema.safeParse(projectId).success) return <section className="page"><h1>Project not found</h1><Link href="/brands">Back to projects</Link></section>;
  return <section className="page project-brand-assets">
    <header className="page-heading"><div><p>Build your brand · Step 3 of 3</p><h1>Brand assets</h1><p>Your chosen direction, ready to use.</p></div><Link href={`/brands/account/${projectId}/logo/directions`}>Back to visual directions</Link></header>
    <AccountStatus />{session.status === "ready" && <OwnedBrandAssets key={`${session.userId}:${session.generation}:${projectId}`} account={session} projectId={projectId} />}
  </section>;
}

function OwnedBrandAssets({ account, projectId }: { account: VerifiedAccount; projectId: string }) {
  const { isCurrent } = useAccountSession(), memory = useLogoDraftMemory();
  const identity = useProjectIdentity(projectId, undefined, { logoDirections: true });
  const logo = useLogoWorkspace({ projectId, memory });
  const { client } = identity;
  const system = identity.checked ? identity.overview?.currentSelection?.system ?? null : null;
  const batchId = system?.source.kind === "generated" ? system.source.batchId : null;
  const [check, setCheck] = useState<{ client: typeof client; batchId: string; batch: IdentityBatchState | null; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!client || !batchId) return;
    const controller = new AbortController();
    void client.batch(batchId, controller.signal).then(batch => {
      if (!controller.signal.aborted && client.current()) setCheck({ client, batchId, batch, error: batch ? null : "The saved direction could not be checked." });
    }).catch(() => {
      if (!controller.signal.aborted && client.current()) setCheck({ client, batchId, batch: null, error: "The saved direction could not be checked. Your files are kept." });
    });
    return () => controller.abort();
  }, [client, batchId, attempt]);
  const checked = check?.client === client && check.batchId === batchId ? check : null;
  const batch = checked?.batch, sourceLogo = batch?.sourceLogo;
  const sourceMatches = Boolean(batch?.sourceLogoCurrent && sourceLogo && system && batch.systems.some(saved => saved.id === system.id
    && saved.board.asset.versionId === system.board.asset.versionId && saved.board.asset.contentHash === system.board.asset.contentHash));
  const fresh = system && identity.overview ? getIdentityFreshness(system.input.basis, identity.overview.currentBasis).status === "current" : false;
  const revalidate = useCallback(async (signal: AbortSignal) => {
    if (!client?.current() || !system || !sourceLogo || !batchId) return false;
    const [overview, savedBatch] = await Promise.all([client.overview({}, signal), client.batch(batchId, signal)]);
    return Boolean(!signal.aborted && client.current() && overview?.currentSelection?.system.id === system.id
      && savedBatch?.sourceLogoCurrent && JSON.stringify(savedBatch.sourceLogo) === JSON.stringify(sourceLogo)
      && savedBatch.systems.some(saved => JSON.stringify(saved) === JSON.stringify(system))
      && JSON.stringify(overview.currentSelection.system) === JSON.stringify(system)
      && getIdentityFreshness(system.input.basis, overview.currentBasis).status === "current");
  }, [client, system, sourceLogo, batchId]);

  if (!isCurrent(account)) return null;
  if (identity.error || checked?.error || logo.error) return <div role="alert"><p>{identity.error ?? checked?.error ?? logo.error}</p><button className="identity-secondary-button" type="button" onClick={() => { void identity.refresh(); void logo.reload(false); setAttempt(value => value + 1); }}>Check saved direction</button></div>;
  if (!identity.checked || identity.loading || logo.status === "loading" || batchId && !checked) return <p role="status">Loading your chosen direction…</p>;
  if (!system || !batchId || !sourceLogo || !sourceMatches || !fresh) return <div><h2>{system ? "Choose a current visual direction" : "Choose your visual direction first"}</h2><p>{system ? "Your saved direction uses earlier inputs. Return to visual directions to choose a board built around your current logo." : "Compare the three boards, then choose one to create your brand assets."}</p><Link className="identity-primary-button" href={`/brands/account/${projectId}/logo/directions`}>Choose a visual direction</Link></div>;
  if (!client || !logo.client || logo.workspace?.ownerId !== account.userId || logo.workspace.projectId !== projectId) return <p role="status">Checking your saved logo…</p>;
  if (identity.strategyDirty || identity.preferencesDirty || logo.dirty || logo.pending) return <p role="status">Save or resolve your changes before creating brand assets. Your chosen direction is kept.</p>;
  return <BrandAssetsPanel key={`${system.id}:${sourceLogo.preview.reference.versionId}`} system={system} sourceLogo={sourceLogo}
    identityClient={client} logoClient={logo.client} account={account} projectId={projectId} revalidate={revalidate}
    vectorRevisionId={logo.workspace.approvedLogo?.vectorRevisionId ?? null} />;
}
