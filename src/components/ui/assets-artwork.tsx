export function AssetsArtwork({ name }: { name: "filter" | "open" }) {
  const size = name === "filter" ? 17 : 14;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/assets-library/${name}.svg`} width={size} height={size} alt="" aria-hidden="true" />;
}
