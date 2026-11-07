import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HandlesWorkspace, HandleEvidenceDetails, type HandlesWorkspaceProps } from "@/features/handles-workspace/handles-workspace";
import { createEntry, appendEvidence } from "@/features/handles-workspace/domain";
import { fixtureHandlesState } from "@/features/handles-workspace/fixtures";

describe("Handles accessible initial rendering", () => {
  it("opens guided Search with honest tab-only storage and unavailable checks", () => {
    const html = renderToStaticMarkup(createElement(HandlesWorkspace));
    expect(html).toContain('role="tablist"'); expect(html).toContain('aria-selected="true"'); expect(html).toContain("Find your handle. Make it yours");
    expect(html).toContain("Add a business handle"); expect(html).toContain("Prefixes"); expect(html).toContain("Separators");
    expect(html).toContain("It doesn’t check whether they’re taken yet"); expect(html).not.toContain("Threads"); expect(html).toContain("This tab only"); expect(html).not.toContain("Confirmed available");
  });
  it("renders independent favorite/selected/declaration controls and external creation", () => {
    const html = renderToStaticMarkup(createElement<HandlesWorkspaceProps>(HandlesWorkspace, { initialState: fixtureHandlesState, initialView: "library" }));
    expect(html).toContain("Favorited"); expect(html).toContain("Selected"); expect(html).toContain("You created this account");
    expect(html).toContain("Last check: Not checked"); expect(html).toContain("Open platform to create or change an account"); expect(html).not.toContain("Confirmed available");
  });
  it("exposes source/method/dates for missing-profile observations without availability", () => {
    const entry = appendEvidence(createEntry("x", "fixture"), { platform: "x", handle: "fixture", outcome: "profile_missing", authority: "public_profile", source: "Fixture public page", sourceUrl: "https://example.test/fixture", method: "Fixture missing-profile response", checkedAt: "2026-10-05T12:00:00Z", observedAt: "2026-10-05T12:00:01Z", detail: "Synthetic observation" });
    const html = renderToStaticMarkup(createElement(HandleEvidenceDetails, { entry }));
    for (const text of ["Fixture public page", "Fixture missing-profile response", "2026-10-05T12:00:00Z", "profile missing"]) expect(html).toContain(text);
    expect(html).not.toContain("Confirmed available");
  });
});
