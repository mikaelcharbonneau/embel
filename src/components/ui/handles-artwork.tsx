const sizes = { check: 12, remove: 12, "save-search": 16, expand: 16, settings: 20, trademarks: 20, domains: 20, handles: 20, names: 20, ideas: 20, assets: 20, brands: 20, home: 20, mark: 28, edit: 14, refresh: 14, "available-dot": 8, "unavailable-dot": 8,
  "instagram-available": 20, "instagram-unavailable": 20, "tiktok-available": 20, "tiktok-unavailable": 20, "youtube-available": 20, "youtube-unavailable": 20, "x-available": 20, "x-unavailable": 20, "linkedin-available": 20, "linkedin-unavailable": 20, "threads-available": 20, "threads-unavailable": 20, "facebook-available": 20, "facebook-unavailable": 20, "whatsapp-available": 20, "whatsapp-unavailable": 20 } as const;
export type HandlesArtworkName = keyof typeof sizes;

/** Original vector exports from the approved Handles frame; keep their native geometry. */
export function HandlesArtwork({ name }: { name: HandlesArtworkName }) {
  // Tiny local SVGs need no raster optimization; their intrinsic dimensions are intentional.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/handles/${name}.svg`} width={sizes[name]} height={sizes[name]} alt="" aria-hidden="true" />;
}
