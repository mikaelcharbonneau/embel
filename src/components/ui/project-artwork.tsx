const sizes = {
  mark: 28,
  check: 16,
  send: 16,
  collapse: 16,
} as const;
type ProjectArtworkName = keyof typeof sizes;
export function ProjectArtwork({ name }: { name: ProjectArtworkName }) {
  // Original static Figma exports retain their native geometry.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/project-workspace/${name}.svg`} alt="" aria-hidden="true" width={sizes[name]} height={sizes[name]} />
  );
}
