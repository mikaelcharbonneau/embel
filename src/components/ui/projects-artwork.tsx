const actionSizes = { plus: 17, continue: 16, sort: 16, create: 17, device: 16, "empty-projects": 28 } as const;
export function ProjectsArtwork({ name }: { name: keyof typeof actionSizes }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/projects/${name}.svg`} width={actionSizes[name]} height={actionSizes[name]} alt="" aria-hidden="true" />
  );
}
