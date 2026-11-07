/** Plain titles for saved asset kinds. Stored kinds are internal identifiers
 * such as "logo_identity_system"; people see "Brand board". */
const labels: Readonly<Record<string, string>> = {
  logo: "Logo",
  logo_concept: "Logo",
  logo_variant: "Logo variation",
  logo_vector: "Vector logo",
  logo_export: "Logo files",
  logo_direction: "Creative direction",
  logo_identity_system: "Brand board",
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
  const value = (kind ?? "").trim(), key = value.toLowerCase();
  if (Object.hasOwn(labels, key)) return labels[key]!;
  // Older records may already hold a written title, such as "Primary mark".
  if (!/^[a-z0-9_-]+$/.test(value)) return value || "Saved file";
  // Unknown identifiers still read as words: "logo_mockup" becomes "Logo mockup".
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : "Saved file";
}
