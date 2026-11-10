import {
  identityGraphicsVersionSchema,
  identityPaletteVersionSchema,
  type IdentityGraphicsVersion,
  type IdentityPaletteVersion,
} from "@/domain/logo-directions";
import { sameLogoScope } from "@/domain/logo-vector";
import { canonicalIdentityInput } from "./font-check-binding";
/** A fixed-size passive SVG tile. No fetched images, executable markup or arbitrary SVG. */
export function renderDirectionGraphics(
  component: IdentityGraphicsVersion,
  palette: IdentityPaletteVersion,
): Uint8Array {
  const graphics = identityGraphicsVersionSchema.parse(component),
    colors = identityPaletteVersionSchema.parse(palette);
  if (
    !sameLogoScope(graphics, colors) ||
    graphics.approvedLogoId !== colors.approvedLogoId ||
    canonicalIdentityInput(graphics.inputRevisions) !== canonicalIdentityInput(colors.inputRevisions)
  )
    throw new TypeError("Graphics and palette require the same approved source.");
  const shapes = graphics.elements.map((element, index) => {
    const color = colors.swatches.find((s) => s.key === element.paletteKey)?.color.hex;
    if (!color) throw new TypeError("A graphic color is missing from this palette.");
    if (element.kind === "dots") {
      if (element.spacing < 2 || element.spacing > 512 || element.radius > 256)
        throw new TypeError("The dot pattern exceeds supported drawing bounds.");
      return `<defs><pattern id="g${index}" patternUnits="userSpaceOnUse" width="${element.spacing}" height="${element.spacing}"><circle cx="${element.spacing / 2}" cy="${element.spacing / 2}" r="${element.radius}" fill="${color}"/></pattern></defs><rect width="256" height="160" fill="url(#g${index})"/>`;
    }
    if (element.kind === "stripes") {
      if (element.spacing < 2 || element.spacing > 512 || element.width > 256)
        throw new TypeError("The stripe pattern exceeds supported drawing bounds.");
      return `<defs><pattern id="g${index}" patternUnits="userSpaceOnUse" width="${element.spacing}" height="${element.spacing}" patternTransform="rotate(${element.rotation})"><rect width="${element.width}" height="${element.spacing}" fill="${color}"/></pattern></defs><rect width="256" height="160" fill="url(#g${index})"/>`;
    }
    if (element.width > 512 || element.height > 512 || Math.abs(element.x) > 512 || Math.abs(element.y) > 512)
      throw new TypeError("The shape exceeds supported drawing bounds.");
    if (element.shape === "circle")
      return `<ellipse cx="${element.x + element.width / 2}" cy="${element.y + element.height / 2}" rx="${element.width / 2}" ry="${element.height / 2}" fill="${color}"/>`;
    if (element.shape === "rectangle")
      return `<rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" fill="${color}"/>`;
    return `<path d="M${element.x + element.width / 2} ${element.y}L${element.x + element.width} ${element.y + element.height}L${element.x} ${element.y + element.height}Z" fill="${color}"/>`;
  });
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 160" width="256" height="160">${shapes.join("")}</svg>`,
  );
}
