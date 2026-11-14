// Original Figma exports retain their native geometry; decorative artwork has no accessible name.
const dimensions = {
  "card-mark": 32,
  "submit-arrow": 17,
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
