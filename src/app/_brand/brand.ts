import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const siteTitle = "Embel — Brand workspace";
export const siteDescription = "A considered workspace for your brand, from the first brief to the details.";

/** Brand assets for generated images, read from the same files the app serves. */
export const brandColors = { canvas: "#F7F7F5", ink: "#191919", secondary: "#696965" } as const;

export async function brandMarkDataUri() {
  const svg = await readFile(join(process.cwd(), "public/embel-mark.svg"));
  return `data:image/svg+xml;base64,${svg.toString("base64")}`;
}

export function geistFont(weight: "Regular" | "Medium") {
  return readFile(join(process.cwd(), `node_modules/geist/dist/fonts/geist-sans/Geist-${weight}.ttf`));
}
