import { zipSync } from "fflate";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import type { AccountIdentityClient } from "@/components/identity/account-identity-client";
import { serializeLogoSvg } from "@/features/logo-vector/model/svg";
import { BrandAssetError, type BrandAssetSnapshot } from "../model/snapshot";
import {
  BRAND_APPLICATIONS,
  brandCopy,
  createBrandApplication,
  createFinalBrandBoard,
  DEFAULT_DIRECTION_CROPS,
  directionCrops,
  drawBrandArtwork,
  drawReversedLogo,
  drawTransparentLogo,
  editableBrandSvg,
  type BrandCrop,
} from "../model/artwork";
import { brandGuideHtml, brandPackReadme, brandPaletteFiles } from "../model/guides";
import { designTokens, designTokensCss, designTokensJson } from "../model/design-tokens";
import { brandCanvasPng, checkBrandAssetSignal, loadBrandFonts, readBrandImage } from "./browser-assets";

export type BrandAssetFile = {
  name: string;
  label: string;
  category: "board" | "logo" | "direction" | "social" | "guide";
  mimeType: string;
  bytes: Uint8Array<ArrayBuffer>;
  width?: number;
  height?: number;
  editable?: boolean;
};
export type PreparedBrandAssets = {
  files: readonly BrandAssetFile[];
  getArchive(): Uint8Array<ArrayBuffer>;
  vectorIncluded: boolean;
  /** Brand images this browser could not draw; everything else is in `files`. */
  failed?: readonly { name: string; label: string }[];
};

/** A small copy of the direction board, measured to choose its three details. */
function measureCrops(direction: { image: CanvasImageSource }): readonly BrandCrop[] {
  try {
    const canvas = document.createElement("canvas"),
      size = 128;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return DEFAULT_DIRECTION_CROPS;
    ctx.drawImage(direction.image, 0, 0, size, size);
    return directionCrops(ctx.getImageData(0, 0, size, size).data, size, size);
  } catch {
    return DEFAULT_DIRECTION_CROPS;
  }
}
/** Pictures for the guidelines file: smaller logo copies and the direction's
 * details as JPEG, so the single HTML file stays light. Left out if this
 * browser cannot encode them; the guidelines then show text only. */
function guideImages(
  logo: { image: CanvasImageSource; width: number; height: number },
  reversed: { image: CanvasImageSource },
  direction: { image: CanvasImageSource; width: number; height: number },
  crops: readonly BrandCrop[],
) {
  try {
    const scaled = (source: CanvasImageSource) => {
      const scale = Math.min(1, 640 / logo.width, 640 / logo.height),
        canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(logo.width * scale));
      canvas.height = Math.max(1, Math.round(logo.height * scale));
      canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    };
    const detail = (crop: BrandCrop) => {
      const canvas = document.createElement("canvas");
      canvas.width = 688;
      canvas.height = 516;
      let sx = crop.x * direction.width,
        sy = crop.y * direction.height,
        sw = crop.width * direction.width,
        sh = crop.height * direction.height;
      if (sw / sh > 4 / 3) {
        sx += (sw - (sh * 4) / 3) / 2;
        sw = (sh * 4) / 3;
      } else {
        sy += (sh - (sw * 3) / 4) / 2;
        sh = (sw * 3) / 4;
      }
      canvas.getContext("2d")?.drawImage(direction.image, sx, sy, sw, sh, 0, 0, 688, 516);
      return canvas.toDataURL("image/jpeg", 0.82);
    };
    return { logo: scaled(logo.image), logoReversed: scaled(reversed.image), crops: crops.map(detail) };
  } catch {
    return {};
  }
}
const extension = (mime: string) =>
  mime === "image/png"
    ? "png"
    : mime === "image/jpeg"
      ? "jpg"
      : mime === "image/webp"
        ? "webp"
        : (() => {
            throw new BrandAssetError("source");
          })();
const sameReference = (a: BrandAssetSnapshot["logo"]["reference"], b: BrandAssetSnapshot["logo"]["reference"]) =>
  a.ownerId === b.ownerId &&
  a.projectId === b.projectId &&
  a.assetId === b.assetId &&
  a.versionId === b.versionId &&
  a.contentHash === b.contentHash;

function preparedAssets(
  files: readonly BrandAssetFile[],
  vectorIncluded: boolean,
  failed: readonly { name: string; label: string }[] = [],
): PreparedBrandAssets {
  if (files.reduce((size, file) => size + file.bytes.length, 0) > 157_286_400) throw new BrandAssetError("size");
  let archive: Uint8Array<ArrayBuffer> | undefined;
  return {
    files,
    vectorIncluded,
    failed,
    getArchive() {
      if (archive) return archive;
      const mtime = new Date("2000-01-01T00:00:00Z");
      const compressed = zipSync(Object.fromEntries(files.map((file) => [file.name, [file.bytes, { mtime }]])), {
        level: 6,
      });
      if (compressed.length > 104_857_600) throw new BrandAssetError("size");
      archive = compressed;
      return archive;
    },
  };
}

/** Local rendering from verified saved sources. This never admits a generation job. */
export async function buildBrandAssetPack(
  input: {
    snapshot: BrandAssetSnapshot;
    logoClient: AccountLogoClient;
    identityClient: AccountIdentityClient;
    vectorRevisionId?: string | null;
    slogan?: string | null;
    positioning?: string | null;
    /** The chosen direction's name, as shown on Creative direction. */
    direction?: string | null;
    audience?: readonly string[];
    traits?: readonly string[];
    date?: Date;
  },
  signal: AbortSignal,
): Promise<PreparedBrandAssets> {
  const { snapshot, logoClient, identityClient } = input;
  checkBrandAssetSignal(signal);
  const logo = await readBrandImage(
    snapshot.logo.reference,
    snapshot.logo.verification.mimeType,
    (signal) => logoClient.previewAsset(snapshot.logo, signal),
    signal,
  );
  try {
    if (logo.bytes.length !== snapshot.logo.verification.byteLength) throw new BrandAssetError("source");
    const direction = await readBrandImage(
      snapshot.board,
      snapshot.board.mimeType,
      (signal) => identityClient.preview(snapshot.board, signal),
      signal,
    );
    try {
      // The saved slogan and positioning fill the artwork's text; missing lines are left out.
      const copy = brandCopy(snapshot, { slogan: input.slogan, positioning: input.positioning });
      // Raster copies of the original for light and dark surfaces; the original file is kept unchanged.
      const derive = (draw: typeof drawTransparentLogo) => {
        const canvas = document.createElement("canvas");
        draw(canvas, logo);
        return {
          canvas,
          image: canvas,
          width: logo.width,
          height: logo.height,
          dataUrl: canvas.toDataURL("image/png"),
        };
      };
      const transparent = derive(drawTransparentLogo),
        reversed = derive(drawReversedLogo);
      const crops = measureCrops(direction);
      const images = { logo: transparent, logoReversed: reversed, direction },
        board = createFinalBrandBoard(snapshot, copy, { direction: input.direction, crops }),
        applications = BRAND_APPLICATIONS.map((spec) => ({ spec, art: createBrandApplication(snapshot, spec, copy) }));
      const fonts = await loadBrandFonts([board, ...applications.map((row) => row.art)], signal);
      try {
        const files: BrandAssetFile[] = [],
          failed: { name: string; label: string }[] = [];
        const render = async (
          name: string,
          label: string,
          category: "board" | "social",
          art: typeof board,
          editable: boolean,
        ) => {
          checkBrandAssetSignal(signal);
          const canvas = document.createElement("canvas");
          let fitted: typeof board, bytes: Uint8Array<ArrayBuffer>;
          try {
            fitted = drawBrandArtwork(canvas, art, images, fonts.names);
            bytes = await brandCanvasPng(canvas, signal);
          } catch (error) {
            // One image this browser cannot draw is reported; the rest of the kit stays usable.
            if (!(error instanceof BrandAssetError) || error.reason !== "canvas") throw error;
            failed.push({ name, label });
            return;
          }
          files.push({
            name: `${name}.png`,
            label,
            category,
            mimeType: "image/png",
            bytes,
            width: art.width,
            height: art.height,
          });
          if (editable)
            files.push({
              name: `${name}.svg`,
              label,
              category,
              mimeType: "image/svg+xml",
              bytes: Uint8Array.from(editableBrandSvg(fitted, images)),
              width: art.width,
              height: art.height,
              editable: true,
            });
        };
        await render("brand-board", "Brand board", "board", board, false);
        files.push({
          name: `logo/logo-original.${extension(snapshot.logo.verification.mimeType)}`,
          label: "Original logo",
          category: "logo",
          mimeType: snapshot.logo.verification.mimeType,
          bytes: logo.bytes,
          width: logo.width,
          height: logo.height,
        });
        files.push({
          name: `direction/selected-direction.${extension(snapshot.board.mimeType)}`,
          label: "Selected direction",
          category: "direction",
          mimeType: snapshot.board.mimeType,
          bytes: direction.bytes,
          width: direction.width,
          height: direction.height,
        });
        for (const { spec, art } of applications)
          await render(`social/${spec.id}`, spec.label, "social", art, spec.editable);
        // Encoding releases the derived canvases, so it follows all artwork.
        const pictures = guideImages(transparent, reversed, direction, crops);
        files.push(
          {
            name: "logo/logo-transparent.png",
            label: "Logo, transparent background",
            category: "logo",
            mimeType: "image/png",
            bytes: await brandCanvasPng(transparent.canvas, signal),
            width: logo.width,
            height: logo.height,
          },
          {
            name: "logo/logo-reversed.png",
            label: "Reversed logo",
            category: "logo",
            mimeType: "image/png",
            bytes: await brandCanvasPng(reversed.canvas, signal),
            width: logo.width,
            height: logo.height,
          },
        );
        let vectorIncluded = false;
        if (input.vectorRevisionId) {
          try {
            const vector = await logoClient.readLogoVectorDetail(input.vectorRevisionId, signal);
            if (vector && sameReference(vector.revision.sourcePreview, snapshot.logo.reference)) {
              files.push({
                name: "logo/logo-vector.svg",
                label: "Saved vector logo",
                category: "logo",
                mimeType: "image/svg+xml",
                bytes: Uint8Array.from(serializeLogoSvg(vector.document)),
              });
              vectorIncluded = true;
            }
          } catch {
            checkBrandAssetSignal(signal); /* A missing optional vector does not remove usable raster assets. */
          }
        }
        const palette = brandPaletteFiles(snapshot);
        files.push(
          {
            name: "guides/colors.json",
            label: "Color palette",
            category: "guide",
            mimeType: "application/json",
            bytes: palette.json,
          },
          {
            name: "guides/colors.css",
            label: "Color variables",
            category: "guide",
            mimeType: "text/css",
            bytes: palette.css,
          },
          {
            name: "guides/brand-guide.html",
            label: "Brand guidelines",
            category: "guide",
            mimeType: "text/html",
            bytes: brandGuideHtml(snapshot, {
              slogan: input.slogan ?? null,
              positioning: input.positioning ?? null,
              audience: input.audience,
              traits: input.traits,
              direction: input.direction,
              date: input.date,
              images: pictures,
            }),
          },
          {
            name: "README.txt",
            label: "File guide",
            category: "guide",
            mimeType: "text/plain",
            bytes: brandPackReadme(snapshot, vectorIncluded, input.slogan ?? null),
          },
        );
        // Assets · Design system: the same tokens the screen shows, ready for code and design tools.
        const tokens = designTokens(snapshot),
          encode = (text: string) => new TextEncoder().encode(text);
        files.push(
          {
            name: "design-system/design-tokens.css",
            label: "Design tokens",
            category: "guide",
            mimeType: "text/css",
            bytes: encode(designTokensCss(tokens)),
          },
          {
            name: "design-system/design-tokens.json",
            label: "Design tokens",
            category: "guide",
            mimeType: "application/json",
            bytes: encode(designTokensJson(tokens)),
          },
        );
        checkBrandAssetSignal(signal);
        return preparedAssets(files, vectorIncluded, failed);
      } finally {
        fonts.release();
      }
    } finally {
      direction.release();
    }
  } finally {
    logo.release();
  }
}
