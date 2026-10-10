export type NamesArtworkName = "heart" | "copy" | "x" | "plus" | "arrow-left-right" | "scissors" | "eraser" | "repeat-2" | "languages" | "arrow-right-left" | "case-sensitive" | "columns-2" | "copy-plus" | "case-upper";
/** Unmodified 16px exports from the approved Names components. */
export function NamesArtwork({ name }: { name: NamesArtworkName }) {
  // Native geometry is part of the approved artwork; these local SVGs need no optimization.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/names/${name}.svg`} width={16} height={16} alt="" aria-hidden="true" />;
}
const shellSizes = { mark: 28, home: 20, brands: 20, assets: 20, ideas: 20, names: 20, handles: 20, domains: 20, trademarks: 20, settings: 20, expand: 16 } as const;
export type NamesShellArtworkName = keyof typeof shellSizes;
export function NamesShellArtwork({ name }: { name: NamesShellArtworkName }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/names/shell-${name}.svg`} width={shellSizes[name]} height={shellSizes[name]} alt="" aria-hidden="true" />;
}
