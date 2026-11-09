import type { AccountProject } from "@/domain/project-api";
import { getProjectHandoff } from "@/domain/project-handoff";
import { getIdentityFreshness } from "@/domain/project-identity";
import type { LogoRasterSource } from "@/domain/logo-workspace";
import type { AccountIdentityClient } from "@/components/identity/account-identity-client";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import { identityBatchUnresolved } from "@/components/identity/identity-generation-controller";
import { logoCandidateKey } from "@/components/logo-creation/candidate-review";
import { acceptedConceptAttempt } from "@/components/logo-creation/presentation";
import { hasCurrentBrandAssets } from "@/components/visual-directions/selected-assets";
import { AccountRequestError } from "./account-api";
import { readProjectLogoProgress, type ProjectLogoProgress } from "./project-card-preview";

export type ProjectAction = { label: string; href: string };
type Clients = { logo: AccountLogoClient | null; identity: AccountIdentityClient | null };

async function directionAction(project: AccountProject, source: LogoRasterSource, client: AccountIdentityClient, signal: AbortSignal): Promise<ProjectAction> {
  const href = `/brands/account/${project.id}/logo/directions`;
  const overview = await client.overview({ limit: 1 }, signal);
  if (!overview || overview.project.current_revision !== project.current_revision) throw new AccountRequestError(409);
  const matches = (candidate?: { source: LogoRasterSource }) => candidate && logoCandidateKey(candidate.source) === logoCandidateKey(source);
  if (hasCurrentBrandAssets(overview.currentSelection, source)) {
    return { label: "View brand kit", href: `/brands/account/${project.id}/logo/deliverables` };
  }

  const generation = await client.generation(signal);
  if (!generation) throw new AccountRequestError(502);
  const batch = generation.latest;
  if (batch?.sourceLogoCurrent && matches(batch.sourceLogo)) {
    const count = batch.systems.filter(system => getIdentityFreshness(system.input.basis, overview.currentBasis).status === "current").length;
    if (count > 1) return { label: `Compare ${count} directions`, href };
    if (count === 1) return { label: "Review visual direction", href };
    if (identityBatchUnresolved(batch)) return { label: "Check direction progress", href };
  }
  return { label: "Explore creative directions", href };
}

export async function readProjectVisualState(project: AccountProject, client: AccountLogoClient | null, signal: AbortSignal) {
  if (!client) throw new AccountRequestError(502);
  const logo = await readProjectLogoProgress(client, project.owner_id, project.id, signal);
  if (!logo || logo.workspace.heads.projectRevision !== project.current_revision) throw new AccountRequestError(409);
  return logo;
}

export async function nextProjectAction(project: AccountProject, clients: Clients, logo: ProjectLogoProgress | null, signal: AbortSignal): Promise<ProjectAction> {
  const base = `/brands/account/${project.id}`;
  if (!logo || !clients.logo) throw new AccountRequestError(502);
  if (logo.selected) {
    if (!clients.identity) throw new AccountRequestError(502);
    return directionAction(project, logo.selected, clients.identity, signal);
  }

  const started = Object.values(logo.workspace.stages).some(Boolean);
  if (!started && project.scope === "complete_brand") {
    const { label, href } = getProjectHandoff(project).next;
    return { label, href };
  }

  const href = `${base}/logo`;
  if (started) {
    const batches = await clients.logo.listLogoConceptBatches({ limit: 1 }, signal);
    if (!batches) throw new AccountRequestError(502);
    const latest = batches.items[0];
    if (latest) {
      const batch = await clients.logo.readLogoConceptBatch(latest.id, signal);
      if (!batch) throw new AccountRequestError(502);
      const label = batch.slots.some(slot => acceptedConceptAttempt(slot)) ? "Choose a logo" : "Review logo progress";
      return { label, href };
    }
  }
  return { label: started ? "Continue logo design" : "Start logo design", href };
}

/** The generic entry rechecks the same saved decisions as the card, even if
 * someone follows its link before the card has finished loading. */
export async function readProjectContinuation(project: AccountProject, clients: Clients, signal: AbortSignal) {
  const logo = await readProjectVisualState(project, clients.logo, signal);
  return nextProjectAction(project, clients, logo, signal);
}
