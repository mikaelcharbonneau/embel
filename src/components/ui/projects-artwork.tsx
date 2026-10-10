const sizes = { mark: 28, home: 20, brands: 20, assets: 20, ideas: 20, names: 20, handles: 20, domains: 20, trademarks: 20, settings: 20, expand: 16 } as const;
export type ProjectsShellArtworkName = keyof typeof sizes;
/** Original exports at their native geometry; CSS selects the approved empty-state variant. */
export function ProjectsShellArtwork({ name }: { name: ProjectsShellArtworkName }) {
  return <>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img className="projects-shell-populated" src={`/projects/shell-${name}.svg`} width={sizes[name]} height={sizes[name]} alt="" aria-hidden="true" />
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img className="projects-shell-empty" src={`/projects/empty-shell-${name}.svg`} width={sizes[name]} height={sizes[name]} alt="" aria-hidden="true" />
  </>;
}
const actionSizes = { plus: 17, continue: 16, filter: 20, sort: 16, create: 17, device: 16, "empty-projects": 28 } as const;
export function ProjectsArtwork({ name }: { name: keyof typeof actionSizes }) {
  // eslint-disable-next-line @next/next/no-img-element
  const artwork = <img src={`/projects/${name}.svg`} width={actionSizes[name]} height={actionSizes[name]} alt="" aria-hidden="true" />;
  // Figma's Filter instance has a 16px layout slot and an unscaled, unclipped 20px child.
  return name === "filter" ? <span className="project-filter-artwork" aria-hidden="true">{artwork}</span> : artwork;
}
