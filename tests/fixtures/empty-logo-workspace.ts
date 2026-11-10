import type { AccountProject } from "../../src/domain/project-api";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";
import { syntheticLogoWorkspace } from "./logo-creation";

/** Explicitly no saved Logo work in an owned, route-intercepted project. */
export function emptyLogoWorkspace(project: Pick<AccountProject, "id" | "owner_id" | "current_revision">) {
  const workspace = syntheticLogoWorkspace();
  return logoWorkspaceV2Schema.parse({
    ...workspace,
    ownerId: project.owner_id,
    projectId: project.id,
    heads: { ...workspace.heads, projectRevision: project.current_revision },
  });
}
