const sizes = {
  "chevron-down": 16,
} as const;
type SettingsArtworkName = keyof typeof sizes;
export function SettingsArtwork({ name }: { name: SettingsArtworkName }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/settings/${name}.svg`} width={sizes[name]} height={sizes[name]} alt="" aria-hidden="true" />;
}
