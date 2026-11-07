import { zipSync } from "fflate";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import type { AccountIdentityClient } from "@/components/identity/account-identity-client";
import { serializeLogoSvg } from "@/features/logo-vector/model/svg";
import { BrandAssetError, type BrandAssetSnapshot } from "../model/snapshot";
import { BRAND_APPLICATIONS, createBrandApplication, createFinalBrandBoard, drawBrandArtwork, editableBrandSvg } from "../model/artwork";
import { brandGuideHtml, brandPackReadme, brandPaletteFiles } from "../model/guides";
import { designTokens, designTokensCss, designTokensJson } from "../model/design-tokens";
import { brandCanvasPng, checkBrandAssetSignal, loadBrandFonts, readBrandImage } from "./browser-assets";

export type BrandAssetFile = { name: string; label: string; category: "board" | "logo" | "direction" | "social" | "guide"; mimeType: string; bytes: Uint8Array<ArrayBuffer>; width?: number; height?: number; editable?: boolean };
export type PreparedBrandAssets = { files: readonly BrandAssetFile[]; getArchive(): Uint8Array<ArrayBuffer>; vectorIncluded: boolean };
const extension = (mime: string) => mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : (() => { throw new BrandAssetError("source"); })();
const sameReference = (a: BrandAssetSnapshot["logo"]["reference"], b: BrandAssetSnapshot["logo"]["reference"]) => a.ownerId === b.ownerId && a.projectId === b.projectId && a.assetId === b.assetId && a.versionId === b.versionId && a.contentHash === b.contentHash;

function preparedAssets(files: readonly BrandAssetFile[], vectorIncluded: boolean): PreparedBrandAssets {
  if (files.reduce((size, file) => size + file.bytes.length, 0) > 157_286_400) throw new BrandAssetError("size");
  let archive: Uint8Array<ArrayBuffer> | undefined;
  return {
    files,
    vectorIncluded,
    getArchive() {
      if (archive) return archive;
      const mtime = new Date("2000-01-01T00:00:00Z");
      const compressed = zipSync(Object.fromEntries(files.map(file => [file.name, [file.bytes, { mtime }]])), { level: 6 });
      if (compressed.length > 104_857_600) throw new BrandAssetError("size");
      archive = compressed;
      return archive;
    },
  };
}

/** Local rendering from verified saved sources. This never admits a generation job. */
export async function buildBrandAssetPack(input: { snapshot: BrandAssetSnapshot; logoClient: AccountLogoClient; identityClient: AccountIdentityClient; vectorRevisionId?: string | null; slogan?: string | null }, signal: AbortSignal): Promise<PreparedBrandAssets> {
  const { snapshot, logoClient, identityClient } = input;
  checkBrandAssetSignal(signal);
  const logo = await readBrandImage(snapshot.logo.reference, snapshot.logo.verification.mimeType, signal => logoClient.previewAsset(snapshot.logo, signal), signal);
  try {
    if (logo.bytes.length !== snapshot.logo.verification.byteLength) throw new BrandAssetError("source");
    const direction = await readBrandImage(snapshot.board, snapshot.board.mimeType, signal => identityClient.preview(snapshot.board, signal), signal);
    try {
      const images = { logo, direction }, board = createFinalBrandBoard(snapshot), applications = BRAND_APPLICATIONS.map(spec => ({ spec, art: createBrandApplication(snapshot, spec) }));
      const fonts = await loadBrandFonts([board, ...applications.map(row => row.art)], signal);
      try {
        const files: BrandAssetFile[] = [];
        const render = async (name: string, label: string, category: "board" | "social", art: typeof board, editable: boolean) => {
          checkBrandAssetSignal(signal);
          const canvas = document.createElement("canvas"), fitted = drawBrandArtwork(canvas, art, images, fonts.names);
          files.push({ name: `${name}.png`, label, category, mimeType: "image/png", bytes: await brandCanvasPng(canvas, signal), width: art.width, height: art.height });
          if (editable) files.push({ name: `${name}.svg`, label, category, mimeType: "image/svg+xml", bytes: Uint8Array.from(editableBrandSvg(fitted, images)), width: art.width, height: art.height, editable: true });
        };
        await render("brand-board", "Brand board", "board", board, false);
        files.push({ name: `logo/logo-original.${extension(snapshot.logo.verification.mimeType)}`, label: "Original logo", category: "logo", mimeType: snapshot.logo.verification.mimeType, bytes: logo.bytes, width: logo.width, height: logo.height });
        files.push({ name: `direction/selected-direction.${extension(snapshot.board.mimeType)}`, label: "Selected direction", category: "direction", mimeType: snapshot.board.mimeType, bytes: direction.bytes, width: direction.width, height: direction.height });
        for (const { spec, art } of applications) await render(`social/${spec.id}`, spec.label, "social", art, spec.editable);
        let vectorIncluded = false;
        if (input.vectorRevisionId) {
          try {
            const vector = await logoClient.readLogoVectorDetail(input.vectorRevisionId, signal);
            if (vector && sameReference(vector.revision.sourcePreview, snapshot.logo.reference)) {
              files.push({ name: "logo/logo-vector.svg", label: "Saved vector logo", category: "logo", mimeType: "image/svg+xml", bytes: Uint8Array.from(serializeLogoSvg(vector.document)) }); vectorIncluded = true;
            }
          } catch { checkBrandAssetSignal(signal); /* A missing optional vector does not remove usable raster assets. */ }
        }
        const palette = brandPaletteFiles(snapshot);
        files.push({ name: "guides/colors.json", label: "Color palette", category: "guide", mimeType: "application/json", bytes: palette.json },
          { name: "guides/colors.css", label: "Color variables", category: "guide", mimeType: "text/css", bytes: palette.css },
          { name: "guides/brand-guide.html", label: "Colors, font links and guide", category: "guide", mimeType: "text/html", bytes: brandGuideHtml(snapshot, input.slogan ?? null) },
          { name: "README.txt", label: "File guide", category: "guide", mimeType: "text/plain", bytes: brandPackReadme(snapshot, vectorIncluded, input.slogan ?? null) });
        // Assets · Design system: the same tokens the screen shows, ready for code and design tools.
        const tokens = designTokens(snapshot), encode = (text: string) => new TextEncoder().encode(text);
        files.push({ name: "design-system/design-tokens.css", label: "Design tokens", category: "guide", mimeType: "text/css", bytes: encode(designTokensCss(tokens)) },
          { name: "design-system/design-tokens.json", label: "Design tokens", category: "guide", mimeType: "application/json", bytes: encode(designTokensJson(tokens)) });
        checkBrandAssetSignal(signal);
        return preparedAssets(files, vectorIncluded);
      } finally { fonts.release(); }
    } finally { direction.release(); }
  } finally { logo.release(); }
}
