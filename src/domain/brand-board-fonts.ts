/** Normal variable faces shipped with Embel. Never substitute a font family in
 * a finished asset; generation and rendering share these exact supported ranges. */
export const BRAND_BOARD_FONT_FAMILIES = ["Geist", "Geist Mono", "Lora", "Fraunces", "Manrope"] as const;
export type BrandBoardFontFamily = typeof BRAND_BOARD_FONT_FAMILIES[number];
export const BRAND_BOARD_FONTS = [
  { family: "Geist", id: "geist", minWeight: 100, maxWeight: 900, sha256: "cdcc4815cbf5f9882fa74e48f8ab410a0495781a58ff7316570f664e7e987753", url: "https://vercel.com/font", file: "/fonts/brand/geist-variable.ttf" },
  { family: "Geist Mono", id: "geist-mono", minWeight: 100, maxWeight: 900, sha256: "0e1af3f507a1c8dfbb03d13ffad585834cd45ed7ccb78c756c7ce7873d180d30", url: "https://vercel.com/font", file: "/fonts/brand/geist-mono-variable.ttf" },
  { family: "Lora", id: "lora", minWeight: 400, maxWeight: 700, sha256: "822a6621ccbe8d97d20ac88c1c41f5615c9c2c202eaa75f272cd452aac6475a7", url: "https://fonts.google.com/specimen/Lora", file: "/fonts/brand/lora-variable.ttf" },
  { family: "Fraunces", id: "fraunces", minWeight: 100, maxWeight: 900, sha256: "177ff6c0f14e5550a3c624247cd1189611d4eb65d000b14944c63d967958abbb", url: "https://fonts.google.com/specimen/Fraunces", file: "/fonts/brand/fraunces-variable.ttf" },
  { family: "Manrope", id: "manrope", minWeight: 200, maxWeight: 800, sha256: "3ae11c49db0455a3cc33e37d380f20fdb8c7f8b41dc07625c177e3d87a9d6ae6", url: "https://fonts.google.com/specimen/Manrope", file: "/fonts/brand/manrope-variable.ttf" },
] as const;
export type BrandBoardFont = typeof BRAND_BOARD_FONTS[number];
export function brandBoardFont(family: string): BrandBoardFont | null {
  return BRAND_BOARD_FONTS.find(font => font.family === family) ?? null;
}
export function supportedBrandBoardTypography(style: { family: string; weight: number; style: string }): boolean {
  const font = brandBoardFont(style.family);
  return !!font && style.style === "normal" && Number.isInteger(style.weight) && style.weight >= font.minWeight && style.weight <= font.maxWeight;
}
