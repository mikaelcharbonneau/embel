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
import { deriveSavedLogoInputs } from "@/server/data/logo-saved-inputs";
import { buildLogoConceptPrompt } from "@/server/logo-creation/openai-logo-provider";
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
