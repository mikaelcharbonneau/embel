import { describe, expect, it } from "vitest";
import type { StandaloneImportSource } from "@/domain/standalone-workspaces";
import { importTrademarkName } from "@/components/tools/trademark-account-adapter";
import { parseTrademarkAccountDraft } from "@/features/trademark-workspace/account-codec";
import { assessTrademarkDossier, buildTrademarkDraftPreview, confirmTrademarkReview, createTrademarkDraft } from "@/features/trademark-workspace/domain";

const source: StandaloneImportSource = { projectId: "00000000-0000-4000-8000-000000000001", projectRevision: 2, projectTitle: "Fixture project", name: "Saved fixture name", selectionId: null, candidateId: null, origin: "project_name" };

describe("Trademark explicit owned-name projection", () => {
  it("copies only the name, retains all personal intake and clears the previous review", () => {
    const draft = confirmTrademarkReview({ ...createTrademarkDraft("Old name"), owner: { name: "Owner note", address: "Private address", contact: "Private contact" }, userNotes: "Research notes", goodsServices: "Proposed offering" });
    const imported = importTrademarkName(source, draft);
    expect(imported).toEqual({ ...draft, markName: source.name, reviewedContent: null });
    expect(draft.markName).toBe("Old name");
    expect(assessTrademarkDossier(draft).reviewCurrent).toBe(true);
    expect(assessTrademarkDossier(imported).reviewCurrent).toBe(false);
    expect(buildTrademarkDraftPreview(imported).research).toEqual({ status: "unavailable", matches: [] });
    expect(parseTrademarkAccountDraft(JSON.parse(JSON.stringify(imported)))).toEqual(imported);
  });

  it("does not copy project title, project ownership or selection provenance into legal owner fields", () => {
    const draft = createTrademarkDraft();
    const imported = importTrademarkName({ ...source, selectionId: "00000000-0000-4000-8000-000000000002", candidateId: "00000000-0000-4000-8000-000000000003", origin: "naming_selection" }, draft);
    expect(imported.owner).toEqual({ name: "", address: "", contact: "" });
    expect(Object.keys(imported)).toEqual(Object.keys(draft));
    expect(JSON.stringify(imported)).not.toContain("projectId");
  });

  it("rejects malformed, authority-bearing and partial provenance sources without editing current draft", () => {
    const draft = createTrademarkDraft("Keep me");
    for (const input of [null, { ...source, ownerId: "other" }, { ...source, cleared: true }, { ...source, projectRevision: 0 }, { ...source, name: "" }, { ...source, origin: "naming_selection" }]) {
      expect(() => importTrademarkName(input as StandaloneImportSource, draft)).toThrow();
      expect(draft.markName).toBe("Keep me");
    }
  });
});
