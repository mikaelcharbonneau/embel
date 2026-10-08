import "server-only";
import { identityDirectionsOverviewSchema } from "@/domain/logo-directions";
import { approveIdentityDirectionInputSchema, selectIdentityDirectionComponentsInputSchema, type LogoManualCommand } from "@/domain/logo-workspace";
import type { AuthenticatedContext } from "@/server/auth/context";
import { getIdentityDirections } from "@/server/data/logo-workspace";
import { logoDatabaseError, logoId, logoOwner } from "@/server/data/logo-transaction";
import { ApiError } from "@/server/http/errors";
import { buildDirectionSelectionEvidence } from "./selection";
export async function prepareDirectionEvidence(auth: AuthenticatedContext, projectId: string, command: LogoManualCommand, signal?: AbortSignal) {
  projectId = logoId(projectId); const owner = logoOwner(auth);
  if (signal?.aborted) throw new ApiError("integration_unavailable");
  let input;
  if (command.method === "selectIdentityDirectionComponents") input = selectIdentityDirectionComponentsInputSchema.parse(command.body);
  else if (command.method === "approveIdentityDirection") {
    const body = approveIdentityDirectionInputSchema.parse(command.body), current = await getIdentityDirections(auth, projectId, {}, signal);
    if (!current.selection || current.selection.id !== body.directionSelectionId || current.selection.consistency.hash !== body.consistencyHash) throw new ApiError("conflict");
    input = selectIdentityDirectionComponentsInputSchema.parse({ requestKey: body.requestKey, expected: body.expected, approvedLogoId: current.selection.approvedLogoId, paletteVersionId: current.selection.paletteVersionId, typographyVersionId: current.selection.typographyVersionId, graphicsVersionId: current.selection.graphicsVersionId });
  } else throw new ApiError("invalid_input");
  const read = auth.client.rpc("read_logo_direction_selection_sources", { p_project: projectId, p_body: { paletteVersionId: input.paletteVersionId, typographyVersionId: input.typographyVersionId, graphicsVersionId: input.graphicsVersionId } });
  const response = await (signal ? read.abortSignal(signal) : read);
  if (response.error) throw logoDatabaseError(response.error);
  const overview = identityDirectionsOverviewSchema.parse(response.data);
  if (signal?.aborted) throw new ApiError("integration_unavailable");
  if (overview.ownerId !== owner || overview.projectId !== projectId) throw new ApiError("not_found");
  const result = await buildDirectionSelectionEvidence(overview, input);
  if (command.method === "approveIdentityDirection" && result.consistency.hash !== command.body.consistencyHash) throw new ApiError("conflict");
  return result;
}
