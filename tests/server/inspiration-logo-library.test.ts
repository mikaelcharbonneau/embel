import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  filterInspirationBrands,
  filterInspirationParts,
  inspirationBrands,
  inspirationCatalog,
  inspirationGallery,
  inspirationLogoLibrary,
  INSPIRATION_CATALOG_VERSION,
  INSPIRATION_REFERENCE_LIMIT,
  isLibraryLogo,
  type InspirationOverview,
} from "@/domain/inspiration";
import { contextSnapshotSchema } from "@/domain/projects";
import { deriveSavedLogoInputs } from "@/server/data/logo-saved-inputs";

const root = path.resolve(import.meta.dirname, "../..");
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const migration = readFileSync(
  path.join(root, "supabase/migrations/20261124120000_inspiration_logo_library.sql"),
  "utf8",
);
// Each catalog row's id and descriptor, as the migration installs them.
const rows = new Map(
  [...migration.matchAll(/^\('([0-9a-f-]{36})','2026-10-13\.1','(.*)'::jsonb,array\['logo'\]::text\[\]\)/gmu)].map(
    ([, id, json]) => [id!, JSON.parse(json!.replaceAll("''", "'")) as unknown],
  ),
);

describe("Inspiration logo library", () => {
  it("adds every logo once, with its files, and keeps the catalog within its limits", () => {
    expect(inspirationLogoLibrary.length).toBe(919);
    const ids = inspirationCatalog.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(INSPIRATION_REFERENCE_LIMIT);
    for (const logo of inspirationLogoLibrary) {
      expect(isLibraryLogo(logo)).toBe(true);
      expect(logo.elements).toEqual(["logo"]);
      expect(logo.parts).toHaveLength(1);
      for (const file of [logo.parts[0]!.image, logo.parts[0]!.thumbnail])
        expect(() => readFileSync(path.join(root, "public", file))).not.toThrow();
    }
    expect(inspirationBrands.some(isLibraryLogo)).toBe(false);
  });

  it("installs a catalog row matching each logo exactly", () => {
    expect(rows.size).toBe(inspirationLogoLibrary.length);
    for (const logo of inspirationLogoLibrary) expect(rows.get(logo.id)).toEqual(logo);
  });

  it("shows library logos in the Logos tab after the board logos, never as brands", () => {
    const logos = filterInspirationParts(inspirationGallery, "logo", "");
    expect(logos).toHaveLength(inspirationBrands.length + inspirationLogoLibrary.length);
    expect(logos.slice(0, inspirationBrands.length).every(({ brand }) => !isLibraryLogo(brand))).toBe(true);
    expect(filterInspirationParts(inspirationGallery, "colors", "")).toHaveLength(inspirationBrands.length);
    expect(filterInspirationBrands(inspirationBrands, "").some(isLibraryLogo)).toBe(false);
    expect(filterInspirationParts(inspirationGallery, "logo", "mailchimp").map(({ brand }) => brand.brand)).toEqual([
      "Mailchimp",
    ]);
  });

  it("never sends a liked library logo's name into the logo brief", () => {
    const logo = inspirationLogoLibrary.find((item) => item.slug === "mailchimp")!;
    const project = {
      id: projectId,
      owner_id: ownerId,
      current_revision: 2,
      scope: "complete_brand",
      context: contextSnapshotSchema.parse({
        description: "A bakery",
        activity: "Independent bakery",
        selectedName: "Crumb",
        intake: { identityNotes: "Warm lettering" },
      }),
    };
    const inspiration: InspirationOverview = {
      ownerId,
      projectId,
      projectRevision: 2,
      projectTitle: "Bakery",
      projectScope: "complete_brand",
      catalogVersion: INSPIRATION_CATALOG_VERSION,
      selectionRevision: 1,
      choices: [
        {
          ownerId,
          projectId,
          referenceId: logo.id,
          revision: 1,
          ensemble: false,
          elements: ["logo"],
          updatedAt: "2026-11-24T00:00:00Z",
        },
      ],
    };
    const result = deriveSavedLogoInputs(project, inspiration);
    expect(result.inspirationCount).toBe(1);
    expect(result.draft!.personality).not.toMatch(/mailchimp/iu);
  });
});
