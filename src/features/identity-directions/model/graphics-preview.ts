import {
  identityDirectionVersionSchema, identityGraphicsVersionSchema,
  type IdentityDirectionVersion, type IdentityGraphicSpec, type IdentityGraphicsVersion, type IdentityPaletteVersion,
} from "@/domain/logo-directions";
import { sameLogoScope } from "@/domain/logo-vector";
import { canonicalIdentityInput } from "./font-check-binding";
import { renderDirectionGraphics } from "./graphics";

type GraphicsPreview = {
  elements: readonly IdentityGraphicSpec[];
} & ({ status: "ready"; src: string; key: string } | { status: "unavailable" | "empty"; message: string });

/** Only the deterministic renderer can supply image bytes; saved metadata is never treated as an asset URL. */
export function prepareDirectionGraphicsPreview(
  direction: IdentityDirectionVersion, graphics: IdentityGraphicsVersion | null, palette: IdentityPaletteVersion | null,
): GraphicsPreview {
  if (!graphics) return { status: "unavailable", elements: [], message: "Supporting graphics are unavailable." };
  let elements: readonly IdentityGraphicSpec[] = [];
  try {
    const source = identityDirectionVersionSchema.parse(direction);
    const component = identityGraphicsVersionSchema.parse(graphics);
    const sameBasis = (value: IdentityGraphicsVersion | IdentityPaletteVersion) => sameLogoScope(source, value)
      && source.approvedLogoId === value.approvedLogoId
      && canonicalIdentityInput(source.inputRevisions) === canonicalIdentityInput(value.inputRevisions);
    if (component.id !== source.graphicsVersionId || !sameBasis(component)
      || palette && (palette.id !== source.paletteVersionId || !sameBasis(palette))) {
      return { status: "unavailable", elements: [], message: "Graphic preview unavailable · saved component versions do not match this direction." };
    }
    elements = component.elements;
    if (elements.length === 0) return { status: "empty", elements, message: "No supporting graphics are specified." };
    if (!palette) return { status: "unavailable", elements, message: "Graphic preview unavailable · the saved palette is unavailable." };
    const svg = new TextDecoder().decode(renderDirectionGraphics(component, palette));
    const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    return { status: "ready", elements, src,
      key: canonicalIdentityInput([source.ownerId, source.projectId, source.id, source.approvedLogoId,
        source.inputRevisions, component.id, palette.id, src]) };
  } catch {
    return { status: "unavailable", elements, message: "Graphic preview unavailable · saved specifications could not be rendered safely." };
  }
}
