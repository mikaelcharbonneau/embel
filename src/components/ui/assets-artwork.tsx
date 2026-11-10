const sizes = {
  mark: 28,
  home: 20,
  brands: 20,
  assets: 20,
  ideas: 20,
  names: 20,
  handles: 20,
  domains: 20,
  trademarks: 20,
  settings: 20,
  expand: 16,
} as const;
export type AssetsShellArtworkName = keyof typeof sizes;
export function AssetsShellArtwork({ name }: { name: AssetsShellArtworkName }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/assets-library/shell-${name}.svg`} width={sizes[name]} height={sizes[name]} alt="" aria-hidden="true" />
  );
}
export function AssetsArtwork({ name }: { name: "filter" | "open" }) {
  const size = name === "filter" ? 17 : 14;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/assets-library/${name}.svg`} width={size} height={size} alt="" aria-hidden="true" />;
}
