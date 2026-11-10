import { identityDirectionVersionSchema } from "../../src/domain/logo-directions";
import type { ApprovedLogoIdentitySnapshot } from "../../src/domain/logo-deliverables";
import type { TestDatabase } from "./local-supabase";
import { id } from "../features/identity-deliverables/fixtures";

/** Original synthetic direction records for legacy export fixtures. Their
 * metadata is not provider output; actual production and source checks remain
 * in the host tests. Every stage ID must resolve to an owned direction record. */
export async function seedDeliverableDirections(
  db: TestDatabase,
  snapshot: ApprovedLogoIdentitySnapshot,
  inputRevisions: unknown,
) {
  const directionIds = [id(501), id(502), id(503)];
  snapshot.directionSelection.sourceDirectionIds = [directionIds[0]!];
  for (const [index, directionId] of directionIds.entries()) {
    const record = identityDirectionVersionSchema.parse({
      id: directionId,
      ownerId: snapshot.ownerId,
      projectId: snapshot.projectId,
      approvedLogoId: snapshot.logoApproval.id,
      inputRevisions,
      name: `Synthetic export direction ${index + 1}`,
      paletteVersionId: snapshot.palette.id,
      typographyVersionId: snapshot.typography.id,
      graphicsVersionId: snapshot.graphics.id,
    });
    await db.query(
      "insert into public.logo_direction_records(id,owner_id,project_id,kind,approved_logo_id,record) values($1,$2,$3,'direction',$4,$5)",
      [record.id, record.ownerId, record.projectId, record.approvedLogoId, record],
    );
  }
  return directionIds;
}
