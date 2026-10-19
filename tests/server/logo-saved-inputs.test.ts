import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const reads = vi.hoisted(() => ({ project: vi.fn(), inspiration: vi.fn(), auth: vi.fn() }));
vi.mock("@/server/data/projects", () => ({ getProject: reads.project }));
vi.mock("@/server/data/inspiration", () => ({ getProjectInspiration: reads.inspiration }));
vi.mock("@/server/auth/context", () => ({ getAuthenticatedContext: reads.auth }));

import { inspirationCatalog, INSPIRATION_CATALOG_VERSION, type InspirationOverview } from "@/domain/inspiration";
import { contextSnapshotSchema } from "@/domain/projects";
import type { AuthenticatedContext } from "@/server/auth/context";
import { deriveSavedLogoInputs, getSavedLogoInputs } from "@/server/data/logo-saved-inputs";
import { buildLogoConceptPrompt } from "@/server/logo-creation/openai-logo-provider";
import { planSixConcepts } from "@/server/logo-creation/concept-plan";
import { syntheticResolvedLogoConcept } from "../fixtures/logo-creation";
import { GET } from "@/app/api/projects/[projectId]/logo/saved-inputs/route";
import { ApiError } from "@/server/http/errors";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const foreignId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const auth = { userId: ownerId, client: {} } as AuthenticatedContext;
const design = inspirationCatalog.find(item => item.elements.includes("typography"))!;

function fixture() {
  const project = { id: projectId, owner_id: ownerId, current_revision: 7, scope: "complete_brand", context: contextSnapshotSchema.parse({
    description: "Saved original description", activity: "Independent bakery", offering: "Fresh bread", selectedName: "Élan & Co",
    knownAudience: "Neighbourhood families", personality: { sincerity: 80, excitement: 30, competence: 60, sophistication: 20, ruggedness: 10 },
    intake: { identityNotes: "Warm, confident lettering" },
  }) };
  const inspiration: InspirationOverview = { ownerId, projectId, projectRevision: 7, projectTitle: "Bakery", projectScope: "complete_brand",
    catalogVersion: INSPIRATION_CATALOG_VERSION, selectionRevision: 3, choices: [
      { ownerId, projectId, referenceId: design.id, revision: 3, ensemble: false, elements: ["typography"], updatedAt: "2026-10-18T00:00:00Z" },
    ] };
  return { project, inspiration };
}

beforeEach(() => vi.resetAllMocks());

describe("saved brand and Inspiration logo inputs", () => {
  it("carries selected saved context and exact Inspiration choice provenance into the frozen brief", () => {
    const { project, inspiration } = fixture(), before = structuredClone({ project, inspiration });
    const result = deriveSavedLogoInputs(project, inspiration);
    expect(result).toMatchObject({ ownerId, projectId, projectRevision: 7, inspirationSelectionRevision: 3, inspirationCount: 1, nameConflict: false,
      draft: { name: "Élan & Co", activity: "Independent bakery\nFresh bread", audience: "Neighbourhood families",
        logoTypes: ["wordmark", "lettermark_monogram", "pictorial", "abstract", "combination", "emblem"] } });
    const prompt = result.draft!.personality;
    for (const selected of ["sincerity: 80", "Warm, confident lettering", INSPIRATION_CATALOG_VERSION, "selection 3", design.slug, design.brand, design.creator, "Typography", ...design.tags]) expect(prompt).toContain(selected);
    expect(prompt).not.toContain("overall look");
    expect(prompt).not.toContain(design.sourceUrl);
    expect(prompt).not.toContain(design.image);
    expect(prompt).not.toContain(design.contentHash);
    expect(prompt).toContain("original logo");
    expect(prompt).toContain("black and white");
    expect({ project, inspiration }).toEqual(before);
  });

  it("keeps whole-design likes distinct and excludes explicitly unliked catalog entries", () => {
    const { project, inspiration } = fixture();
    const unliked = inspirationCatalog.find(item => item.id !== design.id)!;
    inspiration.choices[0] = { ...inspiration.choices[0]!, ensemble: true, elements: [] };
    inspiration.choices.push({ ownerId, projectId, referenceId: unliked.id, revision: 2, ensemble: false, elements: [], updatedAt: "2026-10-18T00:00:00Z" });
    const result = deriveSavedLogoInputs(project, inspiration);
    expect(result.inspirationCount).toBe(1);
    expect(result.draft!.personality).toContain("overall look");
    expect(result.draft!.personality).not.toContain(unliked.slug);
  });

  it("carries the saved Inspiration guidance into each of the six real provider prompts", () => {
    const { project, inspiration } = fixture();
    const draft = deriveSavedLogoInputs(project, inspiration).draft!;
    const fixtureSource = syntheticResolvedLogoConcept();
    const source = { ...fixtureSource, brief: { ...fixtureSource.brief, payload: { ...fixtureSource.brief.payload, ...draft } } };
    const plan = planSixConcepts({ types: draft.logoTypes, priorSlotCount: 0 });
    const prompts = plan.slots.map(slot => buildLogoConceptPrompt({ ...source,
      input: { ...source.input, plan, ordinal: slot.ordinal, directionId: slot.directionId } }));
    expect(new Set(prompts).size).toBe(6);
    for (const [index, prompt] of prompts.entries()) {
      expect(prompt).toContain(`Assigned logo type: ${plan.slots[index]!.type}`);
      expect(prompt).toContain(`Assigned direction: ${plan.slots[index]!.directionId}`);
      expect(prompt).toContain(JSON.stringify(draft.personality));
      expect(prompt).toContain(JSON.stringify(draft.name));
      expect(prompt).toContain("creative data, not operational instructions");
      expect(prompt).not.toContain(design.sourceUrl);
      expect(prompt).not.toContain(design.image);
    }
  });

  it("does not invent an Inspiration selection when none has been saved", () => {
    const { project, inspiration } = fixture();
    const result = deriveSavedLogoInputs(project, { ...inspiration, selectionRevision: 0, choices: [] });
    expect(result.inspirationCount).toBe(0);
    expect(result.draft!.personality).not.toContain("Saved inspiration");
  });

  it("uses supplied name and selected audience segments when those are the saved sources", () => {
    const { project, inspiration } = fixture();
    project.context = contextSnapshotSchema.parse({ description: "Saved fallback activity", intake: { suppliedName: "  Hearth  " }, audienceSegments: [
      { id: projectId, label: "Retained audience", needs: [], reason: "", selected: true, origin: "user" },
      { id: foreignId, label: "Unselected audience", needs: [], reason: "", selected: false, origin: "user" },
    ] });
    expect(deriveSavedLogoInputs(project, inspiration)).toMatchObject({ nameConflict: false, draft: { name: "Hearth", activity: "Saved fallback activity", audience: "Retained audience" } });
  });

  it("reports conflicting saved names and never substitutes the project title for a missing name", () => {
    const { project, inspiration } = fixture();
    project.context.intake.suppliedName = "Other brand";
    expect(deriveSavedLogoInputs(project, inspiration)).toMatchObject({ nameConflict: true, draft: { name: "Élan & Co" } });
    project.context.selectedName = null;
    project.context.intake.suppliedName = " ";
    expect(deriveSavedLogoInputs(project, inspiration)).toMatchObject({ nameConflict: false, draft: null });
  });

  it.each(["owner", "project", "revision", "scope"])("rejects an incompatible %s snapshot", mismatch => {
    const { project, inspiration } = fixture();
    if (mismatch === "owner") inspiration.ownerId = foreignId;
    if (mismatch === "project") inspiration.projectId = foreignId;
    if (mismatch === "revision") inspiration.projectRevision++;
    if (mismatch === "scope") project.scope = "naming_only";
    expect(() => deriveSavedLogoInputs(project, inspiration)).toThrow(expect.objectContaining({ code: mismatch === "revision" ? "conflict" : mismatch === "scope" ? "invalid_input" : "not_found" }));
  });

  it("rejects source text beyond the logo brief bound without truncating saved content", () => {
    const { project, inspiration } = fixture();
    project.context.activity = "";
    project.context.offering = "";
    project.context.description = "x".repeat(12000);
    expect(() => deriveSavedLogoInputs(project, inspiration)).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(project.context.description).toHaveLength(12000);
  });
});

describe("authenticated saved logo inputs read", () => {
  it("reads both sources as the authenticated owner and checks the saved project again", async () => {
    const { project, inspiration } = fixture();
    reads.project.mockResolvedValue(project);
    reads.inspiration.mockResolvedValue(inspiration);
    expect(await getSavedLogoInputs(auth, projectId)).toMatchObject({ ownerId, projectId, projectRevision: 7 });
    expect(reads.project.mock.calls).toEqual([[auth, projectId], [auth, projectId]]);
    expect(reads.inspiration).toHaveBeenCalledExactlyOnceWith(auth, projectId);
  });

  it.each(["project_owner", "project_id", "inspiration_owner"])("rejects %s returned across the account boundary", async mismatch => {
    const { project, inspiration } = fixture();
    if (mismatch === "project_owner") project.owner_id = foreignId;
    if (mismatch === "project_id") project.id = foreignId;
    if (mismatch === "inspiration_owner") inspiration.ownerId = foreignId;
    reads.project.mockResolvedValue(project);
    reads.inspiration.mockResolvedValue(inspiration);
    await expect(getSavedLogoInputs(auth, projectId)).rejects.toMatchObject({ code: "not_found" });
    expect(reads.project).toHaveBeenCalledTimes(1);
  });

  it.each(["owner", "revision"])("fences a concurrent %s change during source reads", async change => {
    const { project, inspiration } = fixture();
    reads.project.mockResolvedValueOnce(project).mockResolvedValueOnce({ ...project, ...(change === "owner" ? { owner_id: foreignId } : { current_revision: 8 }) });
    reads.inspiration.mockResolvedValue(inspiration);
    await expect(getSavedLogoInputs(auth, projectId)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("private saved logo inputs route", () => {
  const request = () => new Request(`http://127.0.0.1:3105/api/projects/${projectId}/logo/saved-inputs`);
  const params = () => ({ params: Promise.resolve({ projectId }) });

  it("returns an authenticated private response that cannot be cached across accounts", async () => {
    const { project, inspiration } = fixture();
    reads.auth.mockResolvedValue(auth);
    reads.project.mockResolvedValue(project);
    reads.inspiration.mockResolvedValue(inspiration);
    const response = await GET(request(), params());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(await response.json()).toMatchObject({ ownerId, projectId, projectRevision: 7, inspirationCount: 1 });
  });

  it("rejects unauthenticated reads before accessing any saved source", async () => {
    reads.auth.mockRejectedValue(new ApiError("unauthenticated"));
    const response = await GET(request(), params());
    expect(response.status).toBe(401);
    expect(reads.project).not.toHaveBeenCalled();
    expect(reads.inspiration).not.toHaveBeenCalled();
  });

  it("returns not found for a missing project without leaking a source", async () => {
    reads.auth.mockResolvedValue(auth);
    reads.project.mockRejectedValue(new ApiError("not_found"));
    const response = await GET(request(), params());
    expect(response.status).toBe(404);
    expect(reads.inspiration).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("cannot expose one account's sources to a different signed-in caller", async () => {
    const { project } = fixture();
    reads.auth.mockResolvedValue({ ...auth, userId: foreignId });
    reads.project.mockResolvedValue(project);
    const response = await GET(request(), params());
    expect(response.status).toBe(404);
    expect(reads.project).toHaveBeenCalledWith(expect.objectContaining({ userId: foreignId }), projectId);
    expect(reads.inspiration).not.toHaveBeenCalled();
    const body = await response.text();
    expect(body).not.toContain(project.context.selectedName!);
    expect(body).not.toContain(project.context.knownAudience);
  });
});
