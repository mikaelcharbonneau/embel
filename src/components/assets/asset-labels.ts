import type { AssetLibraryItem } from "@/domain/asset-library";

/** Plain names for saved asset kinds, in the journey's words. Stored kinds are internal identifiers such as
 * "logo_identity_system" (a creative-direction board); people see "Direction board". A composed brand board is
 * "Brand board". */
const labels: Readonly<Record<string, string>> = {
  logo: "Logo",
  logo_concept: "Logo concept",
  logo_variant: "Logo variation",
  logo_vector: "Vector logo",
  logo_export: "Logo files",
  logo_direction: "Direction board",
  logo_identity_system: "Direction board",
  identity: "Brand board",
  identity_system: "Brand board",
  brand_board: "Brand board",
  palette: "Color palette",
  typography: "Typography",
  graphics: "Brand graphics",
  social: "Social image",
  social_image: "Social image",
  social_profile: "Social profile image",
  post_template: "Post template",
  banner: "Banner",
};

export function assetTitle(kind: string | undefined) {
  const value = (kind ?? "").trim(),
    key = value.toLowerCase();
  if (Object.hasOwn(labels, key)) return labels[key]!;
  // Older records may already hold a written title, such as "Primary mark".
  if (!/^[a-z0-9_-]+$/.test(value)) return value || "Saved file";
  // Unknown identifiers still read as words: "logo_mockup" becomes "Logo mockup".
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : "Saved file";
}

/** The Library's sections inside a brand, in the order of the journey. */
export const LIBRARY_SECTIONS = [
  { id: "logo-concepts", title: "Logo concepts" },
  { id: "direction-boards", title: "Direction boards" },
  { id: "brand-images", title: "Brand images" },
  { id: "logo-files", title: "Logo files" },
  { id: "other", title: "Other files" },
] as const;
export type LibrarySection = (typeof LIBRARY_SECTIONS)[number]["id"];

export function assetSection(kind: string | undefined): LibrarySection {
  switch (assetTitle(kind)) {
    case "Logo concept":
    case "Logo":
      return "logo-concepts";
    case "Direction board":
      return "direction-boards";
    case "Brand board":
    case "Social image":
    case "Social profile image":
    case "Post template":
    case "Banner":
      return "brand-images";
    case "Logo variation":
    case "Vector logo":
    case "Logo files":
      return "logo-files";
    default:
      return "other";
  }
}

/** Where in the journey a kind of file was made, for the detail view ("Identity · Logo"). */
export function assetStep(kind: string | undefined): string | null {
  switch (assetSection(kind)) {
    case "logo-concepts":
    case "logo-files":
      return "Identity · Logo";
    case "direction-boards":
      return "Identity · Creative direction";
    case "brand-images":
      return "Assets · Brand images";
    default:
      return null;
  }
}

export type LibraryEntry = { item: AssetLibraryItem; name: string; chosen: boolean };
export type LibraryBrand = {
  project: AssetLibraryItem["project"];
  entries: LibraryEntry[];
  sections: { id: LibrarySection; title: string; entries: LibraryEntry[] }[];
};

const time = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Groups loaded Library rows by brand, newest brand first, keeping the list's own order (newest first) inside each.
 * `numbered` names each file by its place among that brand's files of the same kind, oldest first ("Logo concept
 * 3"). Pass it only when every file of the brand is loaded and none is filtered out, so the number is the real one.
 */
export function groupLibrary(items: readonly AssetLibraryItem[], numbered: boolean): LibraryBrand[] {
  const brands = new Map<string, LibraryBrand>();
  for (const item of items) {
    let brand = brands.get(item.project.id);
    if (!brand) {
      brand = { project: item.project, entries: [], sections: [] };
      brands.set(item.project.id, brand);
    }
    brand.entries.push({
      item,
      name: assetTitle(item.asset.kind),
      chosen: item.asset.usage.active || item.asset.usage.legacy,
    });
  }
  for (const brand of brands.values()) {
    if (numbered) {
      const byName = new Map<string, LibraryEntry[]>();
      for (const entry of brand.entries) byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
      for (const [name, entries] of byName) {
        if (entries.length < 2 && !["Logo concept", "Direction board"].includes(name)) continue;
        [...entries]
          .sort((a, b) => time(a.item.asset.createdAt) - time(b.item.asset.createdAt))
          .forEach((entry, index) => (entry.name = `${name} ${index + 1}`));
      }
    }
    brand.sections = LIBRARY_SECTIONS.map((section) => ({
      id: section.id,
      title: section.title,
      entries: brand.entries.filter((entry) => assetSection(entry.item.asset.kind) === section.id),
    })).filter((section) => section.entries.length > 0);
  }
  return [...brands.values()];
}
