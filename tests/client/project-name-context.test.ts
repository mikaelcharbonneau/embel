import { describe, expect, it } from "vitest";
import { contextSnapshotSchema } from "@/domain/projects";
import { accountProjectDraft, draftContext } from "@/components/workspace/project-draft-adapter";

const context = contextSnapshotSchema.parse({
  description: "Local test brand", activity: "Studio", offering: "Repairable lighting", knownAudience: "Small homes",
  selectedName: "Lumen", intake: { suppliedName: "Lumen", namingNotes: "Short and warm" },
});
const project = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", owner_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  title: "Test brand", scope: "complete_brand" as const, current_revision: 3, created_at: "2026-10-04T00:00:00Z", context };

describe("account name edits independent of standalone provenance", () => {
  it("mirrors an explicit replacement into both context fields without inventing a standalone source", () => {
    const draft = accountProjectDraft(project);
    const changed = draftContext({ ...draft, suppliedName: "  Lumen Works  " }, context);
    expect(changed.selectedName).toBe("Lumen Works");
    expect(changed.intake.suppliedName).toBe("Lumen Works");
    expect(changed.namingSource).toBeUndefined();
    expect(changed.activity).toBe(context.activity);
    expect(changed.offering).toBe(context.offering);
    expect(context.selectedName).toBe("Lumen");
  });

  it("clears the name consistently while leaving historical snapshots untouched", () => {
    const changed = draftContext({ ...accountProjectDraft(project), suppliedName: "   " }, context);
    expect(changed.selectedName).toBeNull();
    expect(changed.intake.suppliedName).toBe("");
    expect(context.intake.suppliedName).toBe("Lumen");
  });
});
