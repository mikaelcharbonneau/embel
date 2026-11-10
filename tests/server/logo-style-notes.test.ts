import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/data/projects", () => ({ getProject: vi.fn() }));
vi.mock("@/server/data/inspiration", () => ({ getProjectInspiration: vi.fn() }));

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspirationBrands, INSPIRATION_CATALOG_VERSION, type InspirationOverview } from "@/domain/inspiration";
import { inspirationLogoStyles } from "@/domain/inspiration-logo-styles";
import { logoBriefOutdated } from "@/domain/logo-saved-inputs";
import { LIKED_LETTERING, LIKED_LOGO_DIRECTION, LIKED_LOGO_STYLE, logoPromptPersonality, logoTypeDrawsText } from "@/domain/logo-style-notes";
import { contextSnapshotSchema } from "@/domain/projects";
import type { ReferenceElement } from "@/domain/identity-references";
import type { LogoType } from "@/domain/logo-workspace";
import { deriveSavedLogoInputs, likedUploadNotes } from "@/server/data/logo-saved-inputs";
import type { AuthenticatedContext } from "@/server/auth/context";
import { buildLogoConceptPrompt } from "@/server/ai/logo-image-prompts";
import { planSixConcepts } from "@/server/logo-creation/concept-plan";
import { syntheticResolvedLogoConcept } from "../fixtures/logo-creation";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const project = { id: projectId, owner_id: ownerId, current_revision: 7, scope: "complete_brand", context: contextSnapshotSchema.parse({
  description: "An AI-powered branding app", activity: "Branding app", offering: "Logos and brand kits", selectedName: "Embel",
  knownAudience: "First-time founders", personality: { sincerity: 5, excitement: 2, competence: 4, sophistication: 2, ruggedness: 1 },
  intake: { identityNotes: "" },
}) };
function likes(...rows: { brand: (typeof inspirationBrands)[number]; ensemble?: boolean; elements?: ReferenceElement[] }[]): InspirationOverview {
  return { ownerId, projectId, projectRevision: 7, projectTitle: "Embel", projectScope: "complete_brand", catalogVersion: INSPIRATION_CATALOG_VERSION, selectionRevision: 4,
    choices: rows.map(({ brand, ensemble = false, elements = [] }) => ({ ownerId, projectId, referenceId: brand.id, revision: 4, ensemble, elements, updatedAt: "2026-11-09T00:00:00Z" })) };
}
const withSymbol = inspirationBrands.find(brand => inspirationLogoStyles.notes[brand.id]?.symbol && inspirationLogoStyles.notes[brand.id]?.lettering)!;
const note = inspirationLogoStyles.notes[withSymbol.id]!;
function prompts(personality: string, types: LogoType[]) {
  const fixture = syntheticResolvedLogoConcept(), plan = planSixConcepts({ types, priorSlotCount: 0 });
  const source = { ...fixture, brief: { ...fixture.brief, payload: { ...fixture.brief.payload, personality, logoTypes: types } } };
  return plan.slots.map(slot => ({ type: slot.type, prompt: buildLogoConceptPrompt({ ...source, input: { ...source.input, plan, ordinal: slot.ordinal, directionId: slot.directionId } }) }));
}

describe("Inspiration library logo style notes", () => {
  it("has a current note for every brand's logo image", () => {
    for (const brand of inspirationBrands) {
      const logo = brand.parts.find(part => part.part === "logo")!, value = inspirationLogoStyles.notes[brand.id];
      expect(value, brand.slug).toBeDefined();
      expect(value!.logoContentHash, brand.slug).toBe(logo.contentHash);
      expect(createHash("sha256").update(readFileSync(`public${logo.image}`)).digest("hex"), brand.slug).toBe(logo.contentHash);
      expect(value!.symbol ?? value!.lettering, brand.slug).toBeTruthy();
    }
  });
});

describe("liked logos in the logo brief", () => {
  it("adds a liked brand logo's notes and keeps its description for Creative direction", () => {
    const personality = deriveSavedLogoInputs(project, likes({ brand: withSymbol, ensemble: true })).draft!.personality;
    for (const line of [LIKED_LOGO_STYLE + note.symbol, LIKED_LETTERING + note.lettering, LIKED_LOGO_DIRECTION, withSymbol.description]) expect(personality).toContain(line);
    expect(personality.split("\n")[1]).toBe(`Saved inspiration · catalog ${INSPIRATION_CATALOG_VERSION} · selection 4:`);
  });

  it("turns a liked typeface into lettering only", () => {
    const typefaces = withSymbol.parts.find(part => part.part === "typefaces")!;
    const personality = deriveSavedLogoInputs(project, likes({ brand: withSymbol, elements: ["typography"] })).draft!.personality;
    expect(personality).toContain(LIKED_LETTERING + typefaces.description);
    expect(personality).not.toContain(LIKED_LOGO_STYLE);
  });

  it("keeps the earlier format when no liked part guides a logo", () => {
    const personality = deriveSavedLogoInputs(project, likes({ brand: withSymbol, elements: ["colors"] })).draft!.personality;
    expect(personality).not.toContain(LIKED_LOGO_DIRECTION);
    expect(personality).toContain("Use the selected visual qualities as direction for an original logo");
  });

  it("uses at most four liked logos and stays within the brief", () => {
    const liked = inspirationBrands.slice(0, 12).map(brand => ({ brand, ensemble: true, elements: ["logo", "typography", "colors", "images", "composition"] as ReferenceElement[] }));
    const result = deriveSavedLogoInputs(project, likes(...liked)), personality = result.draft!.personality;
    expect(personality.length).toBeLessThanOrEqual(4000);
    const noted = liked.filter(({ brand }) => {
      const value = inspirationLogoStyles.notes[brand.id]!;
      return personality.includes(LIKED_LOGO_STYLE + value.symbol) || personality.includes(LIKED_LETTERING + value.lettering);
    });
    expect(noted.map(({ brand }) => brand.slug)).toEqual(liked.slice(0, 4).map(({ brand }) => brand.slug));
    expect(result.inspirationCount).toBe(12);
  });
});

describe("logo concept prompts from a brief with style notes", () => {
  const personality = deriveSavedLogoInputs(project, likes({ brand: withSymbol, ensemble: true })).draft!.personality;

  it("sends liked lettering only to types that draw text, and no brand descriptions", () => {
    for (const { type, prompt } of prompts(personality, ["wordmark", "lettermark_monogram", "pictorial", "abstract", "combination", "emblem"])) {
      expect(prompt).toContain(JSON.stringify(LIKED_LOGO_STYLE + note.symbol).slice(1, -1));
      expect(prompt.includes(JSON.stringify(LIKED_LETTERING + note.lettering).slice(1, -1)), type).toBe(logoTypeDrawsText(type));
      expect(prompt).not.toContain(JSON.stringify(withSymbol.description).slice(1, -1));
      expect(prompt).toContain("sincerity: 5");
    }
  });

  it("tells symbol-only types to draw the symbol alone", () => {
    for (const { type, prompt } of prompts(personality, ["wordmark", "pictorial", "abstract", "combination", "emblem", "mascot"])) {
      expect(prompt.includes("no letters, initials, brand name or wordmark"), type).toBe(["pictorial", "abstract", "mascot"].includes(type));
    }
  });
});

describe("brief text for image prompts", () => {
  const heading = `Saved inspiration · catalog ${INSPIRATION_CATALOG_VERSION} · selection 2:`;
  it("passes a brief without style notes through unchanged", () => {
    const earlier = ["sincerity: 5", heading, "dropbox-blue-symbol (Dropbox, COLLINS): overall look; geometric, symbol, blue.", "Use the selected visual qualities as direction."].join("\n");
    expect(logoPromptPersonality(earlier, false)).toBe(earlier);
    expect(logoPromptPersonality("Hand-written notes", false)).toBe("Hand-written notes");
  });
  it("keeps the lines before the inspiration block as written", () => {
    const value = ["Warm and calm", heading, LIKED_LOGO_STYLE + "solid modules", LIKED_LETTERING + "rounded sans", "A brand: a long description.", LIKED_LOGO_DIRECTION, "Later identity line."].join("\n");
    expect(logoPromptPersonality(value, false)).toBe(["Warm and calm", heading, LIKED_LOGO_STYLE + "solid modules", LIKED_LOGO_DIRECTION].join("\n"));
    expect(logoPromptPersonality(value, true)).toBe(["Warm and calm", heading, LIKED_LOGO_STYLE + "solid modules", LIKED_LETTERING + "rounded sans", LIKED_LOGO_DIRECTION].join("\n"));
  });
});

describe("saved briefs from before style notes", () => {
  const latest = deriveSavedLogoInputs(project, likes({ brand: withSymbol, ensemble: true }));
  it("treats an earlier-format brief for the same likes as outdated", () => {
    const earlier = ["sincerity: 5", "Saved inspiration · catalog x · selection 4:", `${withSymbol.brand} brand (whole brand): ${withSymbol.description}`].join("\n");
    expect(logoBriefOutdated({ personality: earlier, sourceProjectRevision: 7 }, latest)).toBe(true);
  });
  it("keeps a hand-edited brief that already has style notes", () => {
    const edited = latest.draft!.personality.replace("sincerity: 5", "sincerity: 4");
    expect(logoBriefOutdated({ personality: edited, sourceProjectRevision: 7 }, latest)).toBe(false);
  });
});

describe("liked upload notes in the logo brief", () => {
  const upload = (n: number, status: "ready" | "pending" | "missing" | "unavailable", symbol = `upload ${n} modules`) =>
    ({ referenceId: `eeeeeeee-eeee-4eee-8eee-00000000000${n}`, status, ...(status === "ready" ? { note: { symbol, lettering: null } } : {}) });
  it("puts ready upload notes first and leaves unfinished ones out", () => {
    const result = deriveSavedLogoInputs(project, likes({ brand: withSymbol, ensemble: true }), [],
      [upload(1, "ready"), upload(2, "pending"), upload(3, "unavailable")]);
    const lines = result.draft!.personality.split("\n").filter(line => line.startsWith(LIKED_LOGO_STYLE));
    expect(lines).toEqual([LIKED_LOGO_STYLE + "upload 1 modules", LIKED_LOGO_STYLE + note.symbol]);
    expect(result.uploadNotes.map(row => row.status)).toEqual(["ready", "pending", "unavailable"]);
    expect(result.draft!.personality).toContain(LIKED_LOGO_DIRECTION);
  });
  it("writes the notes block for liked uploads even without library likes", () => {
    const personality = deriveSavedLogoInputs(project, likes(), [], [upload(1, "ready")]).draft!.personality;
    expect(personality).toContain(LIKED_LOGO_STYLE + "upload 1 modules");
    expect(personality).toContain(LIKED_LOGO_DIRECTION);
  });
  it("treats a saved brief that lacks a later upload note as outdated", () => {
    const before = deriveSavedLogoInputs(project, likes({ brand: withSymbol, ensemble: true }), [], [upload(1, "pending")]);
    const after = deriveSavedLogoInputs(project, likes({ brand: withSymbol, ensemble: true }), [], [upload(1, "ready")]);
    expect(logoBriefOutdated({ personality: before.draft!.personality, sourceProjectRevision: 7 }, after)).toBe(true);
    expect(logoBriefOutdated({ personality: after.draft!.personality, sourceProjectRevision: 7 }, after)).toBe(false);
  });
});

describe("liked upload note status", () => {
  const referenceId = "eeeeeeee-eeee-4eee-8eee-000000000001", hash = "1".repeat(64);
  const assetId = "eeeeeeee-eeee-4eee-8eee-000000000002", versionId = "eeeeeeee-eeee-4eee-8eee-000000000003";
  /** The person's own reads: the Logo kinds' switch, the upload's version, and style-note runs and outputs. */
  function client(engine: boolean, runs: object[], outputs: object[], calls: string[] = []) {
    const tables: Record<string, object[]> = { generation_runs: runs, generation_outputs: outputs,
      logo_reference_sources: [{ reference_id: referenceId, asset_id: assetId, version_id: versionId, content_hash: hash, owner_id: ownerId, project_id: projectId, source_kind: "upload" }] };
    const from = (name: string) => { calls.push(name); let found = [...(tables[name] ?? [])] as Record<string, unknown>[];
      const query = { select: () => query, order: () => query, limit: () => query,
        match: (filter: Record<string, unknown>) => { found = found.filter(row => Object.entries(filter).every(([key, value]) => row[key] === undefined || row[key] === value)); return query; },
        in: (key: string, values: unknown[]) => { found = found.filter(row => values.includes(row[key])); return query; },
        then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: found, error: null }).then(resolve) };
      return query; };
    const rpc = async (name: string) => { calls.push(`rpc:${name}`);
      return name === "get_generation_catalog" ? { data: { kinds: ["logo.concepts", "logo.refine", "logo.style_note"].map(kind => ({ kind, enabled: engine })) }, error: null }
        : { data: null, error: { message: "function does not exist" } }; };
    return { userId: ownerId, client: { from, rpc } } as unknown as AuthenticatedContext;
  }
  let runs = 0;
  const run = (status: string, contentHash = hash) => ({ id: `cccccccc-cccc-4ccc-8ccc-${String(++runs).padStart(12, "0")}`, owner_id: ownerId, project_id: projectId, kind: "logo.style_note", status,
    input: { version: 1, revision: 1, references: [{ referenceId, mimeType: "image/png", asset: { ownerId, projectId, assetId, versionId, contentHash } }] } });
  const output = (runId: string, values: Record<string, unknown>, contentHash = hash) => ({ run_id: runId, owner_id: ownerId, output_key: `note.${referenceId}`,
    output: { referenceId, contentHash, noteVersion: "logo-style-note-v1", ...values } });
  const status = async (rows: object[], outputs: object[] = []) => (await likedUploadNotes(client(true, rows, outputs), projectId, [{ referenceId, aspects: ["overall_feel"] }]))[0];

  it("reads no notes, and nothing that production lacks, while the Logo engine is off", async () => {
    const calls: string[] = [];
    expect(await likedUploadNotes(client(false, [run("succeeded")], [], calls), projectId, [{ referenceId, aspects: ["overall_feel"] }])).toEqual([]);
    expect(calls).toEqual(["rpc:get_generation_catalog"]);
  });
  it("is ready only with a note written for the upload's current bytes", async () => {
    const written = run("succeeded");
    expect(await status([written], [output(written.id, { status: "written", symbol: "solid modules", lettering: null })]))
      .toEqual({ referenceId, status: "ready", note: { symbol: "solid modules", lettering: null } });
    const older = run("succeeded", "2".repeat(64));
    expect((await status([older], [output(older.id, { status: "written", symbol: "old", lettering: null }, "2".repeat(64))]))!.status).toBe("missing");
  });
  it("is pending while a run writes it and unavailable after a send whose outcome is unknown", async () => {
    expect((await status([run("running")]))!.status).toBe("pending");
    const unclear = run("failed");
    expect((await status([unclear], [output(unclear.id, { status: "failed", code: "send_interrupted" })]))!.status).toBe("unavailable");
  });
  it("allows a new request after one definite failure, not after two", async () => {
    expect((await status([run("failed")]))!.status).toBe("missing");
    expect((await status([run("failed"), run("failed")]))!.status).toBe("unavailable");
    expect((await status([run("failed", "9".repeat(64)), run("failed", "9".repeat(64))]))!.status).toBe("missing");
  });
});
