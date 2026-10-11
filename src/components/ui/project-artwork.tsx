const sizes = { mark: 28, home: 20, brands: 20, assets: 20, ideas: 20, names: 20, handles: 20, domains: 20, trademarks: 20, settings: 20, check: 16, history: 16, lock: 16, send: 16, collapse: 16, chevron: 16 } as const;
export type ProjectArtworkName = keyof typeof sizes;
export function ProjectArtwork({ name }: { name: ProjectArtworkName }) {
  // Original static Figma exports retain their native geometry.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/project-workspace/${name}.svg`} alt="" aria-hidden="true" width={sizes[name]} height={sizes[name]} />;
}
