const sizes = { check: 12, remove: 12, "save-search": 16, expand: 16, settings: 20, trademarks: 20, domains: 20, handles: 20, names: 20, ideas: 20, assets: 20, brands: 20, home: 20, mark: 28 } as const;
export type HandlesArtworkName = keyof typeof sizes;

/** Original vector exports from the approved Handles frame; keep their native geometry. */
export function HandlesArtwork({ name }: { name: HandlesArtworkName }) {
  // Tiny local SVGs need no raster optimization; their intrinsic dimensions are intentional.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/handles/${name}.svg`} width={sizes[name]} height={sizes[name]} alt="" aria-hidden="true" />;
}
