// Test-only copy of the removed vector editor's edit model: tests use it to make changed documents.
import { logoManualEditSchema, type LogoManualEdit, type LogoVectorDocument, type LogoVectorPath } from "../../../src/domain/logo-vector";
import { validateLogoVectorDocument } from "../../../src/features/logo-vector/model/geometry";
import { LogoVectorError } from "../../../src/features/logo-vector/model/errors";
import { groupLogoComponents } from "./components";

/** Local geometry computation only. The server must separately validate its saved locks and ownership. */
export function applyLogoManualEdit(base: LogoVectorDocument, edit: LogoManualEdit, shapedText?: readonly LogoVectorPath[]): LogoVectorDocument {
  const parsed = logoManualEditSchema.safeParse(edit);
  if (!parsed.success) throw new LogoVectorError("unsupported_edit", "The manual edit violates the shared command contract.");
  const command = parsed.data, document = validateLogoVectorDocument(base);
  // Supplied glyph paths do not establish font rights or an authoritative shaping result.
  void shapedText;
  if (["text", "font", "spacing", "replace_outlined_lettering"].includes(command.kind)) {
    throw new LogoVectorError("font_rights_required", "Text changes require the verified font-rights and shaping service.");
  }
  if (command.kind === "group_components") return groupLogoComponents(document, command.regions);
  const candidate = structuredClone(document);
  const components = new Map(candidate.components.map(component => [component.id, component]));
  const requireComponent = (id: string) => {
    const component = components.get(id);
    if (!component) throw new LogoVectorError("unsupported_edit", "The edit must name an existing component.");
    return component;
  };
  if (command.kind === "locks") {
    command.componentIds.forEach(requireComponent);
    // Lock persistence is a separate authoritative operation; this command never alters geometry.
    return document;
  }
  if (command.kind === "arrangement") {
    if (command.order.length !== candidate.components.length || command.order.some(id => !components.has(id))) {
      throw new LogoVectorError("unsupported_edit", "Arrangement must preserve every existing component exactly once.");
    }
    for (const placement of command.placements) requireComponent(placement.componentId).transform = { ...placement.transform };
    candidate.components = command.order.map(requireComponent);
  } else if (command.kind === "size") requireComponent(command.componentId).transform.scale = command.scale;
  else if (command.kind === "rotation") requireComponent(command.componentId).transform.rotation = command.degrees;
  else if (command.kind === "color") {
    const component = requireComponent(command.componentId);
    component.paths = component.paths.map(path => ({ ...path,
      fill: command.fill === null ? null : { color: command.fill, opacity: path.fill?.opacity ?? 1 },
      stroke: command.stroke === null ? null : { color: command.stroke, opacity: path.stroke?.opacity ?? 1, width: path.stroke?.width ?? 1, linecap: path.stroke?.linecap ?? "butt", linejoin: path.stroke?.linejoin ?? "miter", miterLimit: path.stroke?.miterLimit ?? 4 },
    }));
  }
  return validateLogoVectorDocument(candidate);
}
