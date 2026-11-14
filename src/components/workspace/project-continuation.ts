import type { AccountProject } from "@/domain/project-api";
import { journeyProgress, type JourneyEvidence, type JourneyNext } from "@/domain/journey";
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

/** A project's next action, with its place in the journey (`journeyProgress` in src/domain/journey.ts). */
export type ProjectAction = JourneyNext;
type Clients = { logo: AccountLogoClient | null; identity: AccountIdentityClient | null };

async function directionEvidence(
  project: AccountProject,
  source: LogoRasterSource,
  client: AccountIdentityClient,
  signal: AbortSignal,
): Promise<JourneyEvidence> {
  const overview = await client.overview({ limit: 1 }, signal);
  if (!overview || overview.project.current_revision !== project.current_revision) throw new AccountRequestError(409);
  const matches = (candidate?: { source: LogoRasterSource }) =>
    candidate && logoCandidateKey(candidate.source) === logoCandidateKey(source);
  if (hasCurrentBrandAssets(overview.currentSelection, source)) return { logo: "chosen", brandKit: true };

  const generation = await client.generation(signal);
  if (!generation) throw new AccountRequestError(502);
  const batch = generation.latest;
  if (batch?.sourceLogoCurrent && matches(batch.sourceLogo)) {
    const directions = batch.systems.filter(
      (system) => getIdentityFreshness(system.input.basis, overview.currentBasis).status === "current",
    ).length;
    return { logo: "chosen", brandKit: false, directions, directionsPending: identityBatchUnresolved(batch) };
  }
  return { logo: "chosen", brandKit: false, directions: 0, directionsPending: false };
}

export async function readProjectVisualState(
  project: AccountProject,
  client: AccountLogoClient | null,
  signal: AbortSignal,
) {
  if (!client) throw new AccountRequestError(502);
  const logo = await readProjectLogoProgress(client, project.owner_id, project.id, signal);
  if (!logo || logo.workspace.heads.projectRevision !== project.current_revision) throw new AccountRequestError(409);
  return logo;
}

/** What the saved logo and direction work shows, for `journeyProgress`. Nothing is read past the first answer:
 * a project with no logo work is not asked for its concepts or directions. */
export async function readProjectEvidence(
  project: AccountProject,
  clients: Clients,
  logo: ProjectLogoProgress | null,
  signal: AbortSignal,
): Promise<JourneyEvidence> {
  if (!logo || !clients.logo) throw new AccountRequestError(502);
  if (logo.selected) {
    if (!clients.identity) throw new AccountRequestError(502);
    return directionEvidence(project, logo.selected, clients.identity, signal);
  }
  if (!Object.values(logo.workspace.stages).some(Boolean)) return { logo: "none" };
  const batches = await clients.logo.listLogoConceptBatches({ limit: 1 }, signal);
  if (!batches) throw new AccountRequestError(502);
  const latest = batches.items[0];
  if (!latest) return { logo: "started" };
  const batch = await clients.logo.readLogoConceptBatch(latest.id, signal);
  if (!batch) throw new AccountRequestError(502);
  return { logo: batch.slots.some((slot) => acceptedConceptAttempt(slot)) ? "choose" : "progress" };
}

/** The next action for a project card or the generic entry: the one answer, given the saved logo work. */
export async function nextProjectAction(
  project: AccountProject,
  clients: Clients,
  logo: ProjectLogoProgress | null,
  signal: AbortSignal,
): Promise<ProjectAction> {
  const evidence = await readProjectEvidence(project, clients, logo, signal);
  return journeyProgress({ project, evidence }).next!;
}

/** The generic entry rechecks the same saved decisions as the card, even if
 * someone follows its link before the card has finished loading. */
export async function readProjectContinuation(project: AccountProject, clients: Clients, signal: AbortSignal) {
  const logo = await readProjectVisualState(project, clients.logo, signal);
  return nextProjectAction(project, clients, logo, signal);
}

/** The saved logo work for the open project, read once per revision for the project bar. */
export async function readProjectJourneyEvidence(project: AccountProject, clients: Clients, signal: AbortSignal) {
  const logo = await readProjectVisualState(project, clients.logo, signal);
  return readProjectEvidence(project, clients, logo, signal);
}
