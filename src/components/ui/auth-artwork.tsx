// Original Figma exports retain their native geometry; decorative artwork has no accessible name.
const dimensions = {
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
  "card-mark": 32,
  "submit-arrow": 17,
  device: 16,
  "browser-arrow": 16,
} as const;
export type AuthArtworkName = keyof typeof dimensions;
export function AuthArtwork({ name }: { name: AuthArtworkName }) {
  const size = dimensions[name];
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/auth/${name}.svg`} width={size} height={size} alt="" aria-hidden="true" className="auth-artwork" />
  );
}
