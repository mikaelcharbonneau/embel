import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const reads = vi.hoisted(() => ({ project: vi.fn(), inspiration: vi.fn(), auth: vi.fn() }));
vi.mock("@/server/data/projects", () => ({ getProject: reads.project }));
vi.mock("@/server/data/inspiration", () => ({ getProjectInspiration: reads.inspiration }));
vi.mock("@/server/auth/context", () => ({ getAuthenticatedContext: reads.auth }));

import {
  inspirationBrands,
  inspirationCatalog,
  INSPIRATION_CATALOG_VERSION,
  type InspirationOverview,
} from "@/domain/inspiration";
import { contextSnapshotSchema } from "@/domain/projects";
import type { AuthenticatedContext } from "@/server/auth/context";
import { deriveSavedLogoInputs, getSavedLogoInputs, likedUploadReferences } from "@/server/data/logo-saved-inputs";
import { buildLogoConceptPrompt } from "@/server/ai/logo-image-prompts";
import { planSixConcepts } from "../fixtures/logo-concept-plan";
import { syntheticResolvedLogoConcept } from "../fixtures/logo-creation";
import { GET } from "@/app/api/projects/[projectId]/logo/saved-inputs/route";
import { ApiError } from "@/server/http/errors";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const foreignId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
// Synthetic owned table reads for liked uploads: filters are recorded and applied.
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
  identity_reference_reactions: [],
  identity_references: [],
  logo_reference_sources: [],
};
function table(name: string) {
  let found = [...(tables[name] ?? [])];
  const query = {
    select: () => query,
    match: (filter: Row) => {
      found = found.filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value));
      return query;
    },
    in: (key: string, values: unknown[]) => {
      found = found.filter((row) => values.includes(row[key]));
      return query;
    },
    then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
      Promise.resolve({ data: found, error: null }).then(resolve),
  };
  return query;
}
const auth = { userId: ownerId, client: { from: table } } as unknown as AuthenticatedContext;
const design = inspirationCatalog.find((item) => item.elements.includes("typography"))!;

function fixture() {
  const project = {
    id: projectId,
    owner_id: ownerId,
    current_revision: 7,
    scope: "complete_brand",
    context: contextSnapshotSchema.parse({
      description: "Saved original description",
      activity: "Independent bakery",
      offering: "Fresh bread",
      selectedName: "Élan & Co",
      knownAudience: "Neighbourhood families",
      personality: { sincerity: 80, excitement: 30, competence: 60, sophistication: 20, ruggedness: 10 },
      intake: { identityNotes: "Warm, confident lettering" },
    }),
  };
  const inspiration: InspirationOverview = {
    ownerId,
    projectId,
    projectRevision: 7,
    projectTitle: "Bakery",
    projectScope: "complete_brand",
    catalogVersion: INSPIRATION_CATALOG_VERSION,
    selectionRevision: 3,
    choices: [
      {
        ownerId,
        projectId,
        referenceId: design.id,
        revision: 3,
        ensemble: false,
        elements: ["typography"],
        updatedAt: "2026-10-18T00:00:00Z",
      },
    ],
  };
  return { project, inspiration };
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const name of Object.keys(tables)) tables[name] = [];
});

describe("saved brand and Inspiration logo inputs", () => {
  it("carries selected saved context and exact Inspiration choice provenance into the frozen brief", () => {
    const { project, inspiration } = fixture(),
      before = structuredClone({ project, inspiration });
    const result = deriveSavedLogoInputs(project, inspiration);
    expect(result).toMatchObject({
      ownerId,
      projectId,
      projectRevision: 7,
      inspirationSelectionRevision: 3,
      inspirationCount: 1,
      nameConflict: false,
      draft: {
        name: "Élan & Co",
        activity: "Independent bakery\nFresh bread",
        audience: "Neighbourhood families",
        logoTypes: ["wordmark", "lettermark_monogram", "pictorial", "abstract", "combination", "emblem"],
      },
    });
    const prompt = result.draft!.personality;
    for (const selected of [
      "sincerity: 80",
      "Warm, confident lettering",
      INSPIRATION_CATALOG_VERSION,
      "selection 3",
      design.slug,
      design.brand,
      design.creator,
      "Typography",
      ...design.tags,
    ])
      expect(prompt).toContain(selected);
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
    const unliked = inspirationCatalog.find((item) => item.id !== design.id)!;
    inspiration.choices[0] = { ...inspiration.choices[0]!, ensemble: true, elements: [] };
    inspiration.choices.push({
      ownerId,
      projectId,
      referenceId: unliked.id,
      revision: 2,
      ensemble: false,
      elements: [],
      updatedAt: "2026-10-18T00:00:00Z",
    });
    const result = deriveSavedLogoInputs(project, inspiration);
    expect(result.inspirationCount).toBe(1);
    expect(result.draft!.personality).toContain("overall look");
    expect(result.draft!.personality).not.toContain(unliked.slug);
  });

  it("describes a liked brand and its liked parts, since the model never sees the images", () => {
    const { project, inspiration } = fixture(),
      brand = inspirationBrands[0]!;
    inspiration.choices = [
      {
        ownerId,
        projectId,
        referenceId: brand.id,
        revision: 3,
        ensemble: true,
        elements: ["colors", "images"],
        updatedAt: "2026-11-08T00:00:00Z",
      },
    ];
    const prompt = deriveSavedLogoInputs(project, inspiration).draft!.personality;
    const colors = brand.parts.find((part) => part.part === "colors")!,
      visuals = brand.parts.find((part) => part.part === "visuals")!;
    for (const expected of [
      `${brand.brand} brand (whole brand, colors, visuals):`,
      brand.description,
      `Colors: ${colors.description}`,
      `Visuals: ${visuals.description}`,
    ])
      expect(prompt).toContain(expected);
    for (const unliked of brand.parts.filter((part) => part.part !== "colors" && part.part !== "visuals"))
      expect(prompt).not.toContain(unliked.description);
    expect(prompt).not.toContain(colors.image);
  });

  it("keeps every liked brand, in short form, when full descriptions would overflow the brief", () => {
    // Enough fully liked brands that their full descriptions pass the 2,800-character budget.
    const size = (brand: (typeof inspirationBrands)[number]) =>
      brand.description.length + brand.parts.reduce((total, part) => total + part.description.length + 12, 0);
    const count =
      inspirationBrands.findIndex(
        (_, index) => inspirationBrands.slice(0, index + 1).reduce((total, brand) => total + size(brand), 0) > 3000,
      ) + 1;
    const { project, inspiration } = fixture(),
      liked = inspirationBrands.slice(0, count);
    inspiration.choices = liked
      .map((brand) => ({
        ownerId,
        projectId,
        referenceId: brand.id,
        revision: 3,
        ensemble: true,
        elements: ["logo", "typography", "colors", "images", "composition"] as const,
        updatedAt: "2026-11-08T00:00:00Z",
      }))
      .map((choice) => ({ ...choice, elements: [...choice.elements] }));
    const result = deriveSavedLogoInputs(project, inspiration),
      prompt = result.draft!.personality;
    expect(count).toBeGreaterThan(1);
    expect(result.inspirationCount).toBe(count);
    expect(prompt.length).toBeLessThanOrEqual(4000);
    for (const brand of liked)
      expect(prompt).toContain(`${brand.brand} brand: whole brand, logo, colors, typefaces, socials, visuals;`);
    expect(prompt).not.toContain(liked[0]!.description);
  });

  it("carries the saved Inspiration guidance into each of the six real provider prompts", () => {
    const { project, inspiration } = fixture();
    const draft = deriveSavedLogoInputs(project, inspiration).draft!;
    const fixtureSource = syntheticResolvedLogoConcept();
    const source = {
      ...fixtureSource,
      brief: { ...fixtureSource.brief, payload: { ...fixtureSource.brief.payload, ...draft } },
    };
    const plan = planSixConcepts({ types: draft.logoTypes, priorSlotCount: 0 });
    const prompts = plan.slots.map((slot) =>
      buildLogoConceptPrompt({
        ...source,
        input: { ...source.input, plan, ordinal: slot.ordinal, directionId: slot.directionId },
      }),
    );
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
    project.context = contextSnapshotSchema.parse({
      description: "Saved fallback activity",
      intake: { suppliedName: "  Hearth  " },
      audienceSegments: [
        { id: projectId, label: "Retained audience", needs: [], reason: "", selected: true, origin: "user" },
        { id: foreignId, label: "Unselected audience", needs: [], reason: "", selected: false, origin: "user" },
      ],
    });
    expect(deriveSavedLogoInputs(project, inspiration)).toMatchObject({
      nameConflict: false,
      draft: { name: "Hearth", activity: "Saved fallback activity", audience: "Retained audience" },
    });
  });

  it("reports conflicting saved names and never substitutes the project title for a missing name", () => {
    const { project, inspiration } = fixture();
    project.context.intake.suppliedName = "Other brand";
    expect(deriveSavedLogoInputs(project, inspiration)).toMatchObject({
      nameConflict: true,
      draft: { name: "Élan & Co" },
    });
    project.context.selectedName = null;
    project.context.intake.suppliedName = " ";
    expect(deriveSavedLogoInputs(project, inspiration)).toMatchObject({ nameConflict: false, draft: null });
  });

  it.each(["owner", "project", "revision", "scope"])("rejects an incompatible %s snapshot", (mismatch) => {
    const { project, inspiration } = fixture();
    if (mismatch === "owner") inspiration.ownerId = foreignId;
    if (mismatch === "project") inspiration.projectId = foreignId;
    if (mismatch === "revision") inspiration.projectRevision++;
    if (mismatch === "scope") project.scope = "naming_only";
    expect(() => deriveSavedLogoInputs(project, inspiration)).toThrow(
      expect.objectContaining({
        code: mismatch === "revision" ? "conflict" : mismatch === "scope" ? "invalid_input" : "not_found",
      }),
    );
  });

  it("rejects source text beyond the logo brief bound without truncating saved content", () => {
    const { project, inspiration } = fixture();
    project.context.activity = "";
    project.context.offering = "";
    project.context.description = "x".repeat(12000);
    expect(() => deriveSavedLogoInputs(project, inspiration)).toThrow(
      expect.objectContaining({ code: "invalid_input" }),
    );
    expect(project.context.description).toHaveLength(12000);
  });
});

describe("liked uploaded images as logo references", () => {
  const ref = (n: number) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, "0")}`;
  const owned = { project_id: projectId, owner_id: ownerId };
  it("uses the logo reference each liked upload created, most recently liked first, at most three", async () => {
    tables.identity_reference_reactions = [1, 2, 3, 4, 5].map((n) => ({
      ...owned,
      reference_id: ref(n),
      ensemble: n !== 5,
      elements: [],
      updated_at: `2026-11-08T10:0${n}:00Z`,
    }));
    tables.identity_references = [1, 2, 3, 4, 5].map((n) => ({
      ...owned,
      id: ref(n),
      asset_id: ref(100 + n),
      source: n === 4 ? "curated" : "user_supplied",
    }));
    tables.logo_reference_sources = [1, 2, 3, 4, 5].map((n) => ({
      ...owned,
      reference_id: ref(200 + n),
      asset_id: ref(100 + n),
      source_kind: "upload",
    }));
    // 5 is not liked and 4 is not your own upload; of 1–3, all fit.
    expect(await likedUploadReferences(auth, projectId)).toEqual(
      [1, 2, 3].map((n) => ({ referenceId: ref(200 + n), aspects: ["overall_feel"] })),
    );
    tables.identity_references = tables.identity_references.map((row) => ({ ...row, source: "user_supplied" }));
    expect((await likedUploadReferences(auth, projectId)).map((row) => row.referenceId)).toEqual(
      [2, 3, 4].map((n) => ref(200 + n)),
    );
    tables.identity_reference_reactions = [];
    expect(await likedUploadReferences(auth, projectId)).toEqual([]);
  });
  it("ignores another owner's rows and uploads without a logo reference", async () => {
    tables.identity_reference_reactions = [
      { ...owned, reference_id: ref(1), ensemble: true, elements: [], updated_at: null },
      {
        project_id: projectId,
        owner_id: foreignId,
        reference_id: ref(2),
        ensemble: true,
        elements: [],
        updated_at: null,
      },
    ];
    tables.identity_references = [
      { ...owned, id: ref(1), asset_id: ref(101), source: "user_supplied" },
      { project_id: projectId, owner_id: foreignId, id: ref(2), asset_id: ref(102), source: "user_supplied" },
    ];
    tables.logo_reference_sources = [
      { project_id: projectId, owner_id: foreignId, reference_id: ref(202), asset_id: ref(102), source_kind: "upload" },
    ];
    expect(await likedUploadReferences(auth, projectId)).toEqual([]);
  });
});

describe("authenticated saved logo inputs read", () => {
  it("reads both sources as the authenticated owner and checks the saved project again", async () => {
    const { project, inspiration } = fixture();
    reads.project.mockResolvedValue(project);
    reads.inspiration.mockResolvedValue(inspiration);
    expect(await getSavedLogoInputs(auth, projectId)).toMatchObject({ ownerId, projectId, projectRevision: 7 });
    expect(reads.project.mock.calls).toEqual([
      [auth, projectId],
      [auth, projectId],
    ]);
    expect(reads.inspiration).toHaveBeenCalledExactlyOnceWith(auth, projectId);
  });

  it.each(["project_owner", "project_id", "inspiration_owner"])(
    "rejects %s returned across the account boundary",
    async (mismatch) => {
      const { project, inspiration } = fixture();
      if (mismatch === "project_owner") project.owner_id = foreignId;
      if (mismatch === "project_id") project.id = foreignId;
      if (mismatch === "inspiration_owner") inspiration.ownerId = foreignId;
      reads.project.mockResolvedValue(project);
      reads.inspiration.mockResolvedValue(inspiration);
      await expect(getSavedLogoInputs(auth, projectId)).rejects.toMatchObject({ code: "not_found" });
      expect(reads.project).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["owner", "revision"])("fences a concurrent %s change during source reads", async (change) => {
    const { project, inspiration } = fixture();
    reads.project.mockResolvedValueOnce(project).mockResolvedValueOnce({
      ...project,
      ...(change === "owner" ? { owner_id: foreignId } : { current_revision: 8 }),
    });
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
