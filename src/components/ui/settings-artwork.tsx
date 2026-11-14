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
  figma: 28,
  googledrive: 28,
  notion: 28,
  slack: 28,
  "switch-off": 36,
  "chevron-down": 16,
} as const;
type SettingsArtworkName = keyof typeof sizes;
export function SettingsArtwork({ name }: { name: SettingsArtworkName }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/settings/${name}.svg`} width={sizes[name]} height={sizes[name]} alt="" aria-hidden="true" />;
}
