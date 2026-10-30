import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LogoIdentityContinuation, LogoInputStatus } from "../../src/components/logo-creation/workflow-status";
import { syntheticLogoWorkspace, logoFixtureId as id } from "../fixtures/logo-creation";

describe("logo handoff uses the selected concept and current input evidence", () => {
  const base = syntheticLogoWorkspace();
  const approved = { ...base, approvedLogo: { id: id(700), ownerId: base.ownerId, projectId: base.projectId, vectorRevisionId: id(701), stageRevisionId: id(702), approvedAt: "2026-10-06T12:00:00Z" } };
  it("allows directions without vector approval and ignores optional vector staleness", () => {
    const render = (workspace: typeof base = approved, blocked = false) => renderToStaticMarkup(createElement(LogoIdentityContinuation, { workspace, blocked, hasSelection: true }));
    expect(render()).toContain(`href="/brands/account/${base.projectId}/logo/directions"`);
    expect(render(approved, true)).not.toContain("href=");
    expect(render({ ...approved, staleStages: [{ stage: "brief_references", reasons: ["project_revision_changed"] }] })).not.toContain("/logo/directions");
    expect(render({ ...approved, staleStages: [{ stage: "directions", reasons: ["input_revision_changed"] }] })).toContain("/logo/directions");
    expect(renderToStaticMarkup(createElement(LogoIdentityContinuation, { workspace: base, blocked: false, hasSelection: true }))).toContain("/logo/directions");
    expect(render({ ...base, staleStages: [{ stage: "vector", reasons: ["input_revision_changed"] }] })).toContain("/logo/directions");
    const noSelection = renderToStaticMarkup(createElement(LogoIdentityContinuation, { workspace: approved, blocked: false, hasSelection: false }));
    expect(noSelection).not.toContain("/logo/directions"); expect(noSelection).toContain("Choose a logo concept");
  });
  it("names stale saved stages and offers explicit review without claiming output was regenerated", () => {
    const html = renderToStaticMarkup(createElement(LogoInputStatus, { workspace: { ...approved, staleStages: [
      { stage: "brief_references", reasons: ["project_revision_changed"] }, { stage: "concepts", reasons: ["input_revision_changed"] },
    ] } }));
    expect(html).toContain("Use Reuse Strategy"); expect(html).toContain("Your earlier logo versions are kept"); expect(html).toContain("Logo concepts");
    expect(renderToStaticMarkup(createElement(LogoInputStatus, { workspace: base }))).toBe("");
  });
});
