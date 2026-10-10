const sizes = { mark: 28, home: 20, brands: 20, assets: 20, ideas: 20, names: 20, handles: 20, domains: 20, trademarks: 20, settings: 20, expand: 16, search: 24, check: 12, pending: 16 } as const;
export type TrademarkArtworkName = keyof typeof sizes;
export function TrademarkArtwork({ name }: { name: TrademarkArtworkName }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/trademarks/${name}.svg`} width={sizes[name]} height={sizes[name]} alt="" aria-hidden="true" />;
}
