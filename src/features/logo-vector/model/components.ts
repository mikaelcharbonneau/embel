import {
  logoManualEditSchema, type LogoManualEdit, type LogoVectorComponent,
  type LogoVectorDocument, type LogoVectorPath,
} from "../../../domain/logo-vector";
import {
  canonicalizeLogoPath, flattenLogoPaths, getLogoPathPaintedBounds,
  validateLogoVectorDocument, type LogoPaintedBounds,
} from "./geometry";
import { LogoVectorError } from "./errors";
import { VECTOR_LIMITS } from "./limits";

type Region = Extract<LogoManualEdit, { kind: "group_components" }>["regions"][number];
type Entry = { component: LogoVectorComponent; path: LogoVectorPath; index: number; region: number | null };
const unavailable = (reason: string): never => { throw new LogoVectorError("unsupported_edit", reason); };
const overlaps = (a: LogoPaintedBounds, b: LogoPaintedBounds) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
const contains = (outer: LogoPaintedBounds, inner: LogoPaintedBounds) => inner.minX >= outer.minX && inner.minY >= outer.minY && inner.maxX <= outer.maxX && inner.maxY <= outer.maxY;
const rectangle = ([x, y, width, height]: Region["bounds"]): LogoPaintedBounds => ({ minX: x, minY: y, maxX: x + width, maxY: y + height });

/** Preserve invisible geometry too: a transparent path is still a source path,
 * and may not disappear merely because it contributes no current painted ink. */
function pathBounds(path: LogoVectorPath): LogoPaintedBounds | null {
  const painted = getLogoPathPaintedBounds(path);
  if (painted) return painted;
  const bounds = canonicalizeLogoPath(path.d).getBounds();
  return [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)
    ? { minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY } : null;
}

/** Explicit rectangle partitioning only, never semantic trace detection or path
 * cutting. An affected source must be covered completely; unrelated components
 * remain unchanged. The server separately checks its authoritative saved locks. */
export function groupLogoComponents(base: LogoVectorDocument, regions: readonly Region[]): LogoVectorDocument {
  const command = logoManualEditSchema.safeParse({ kind: "group_components", regions });
  if (!command.success || command.data.kind !== "group_components") return unavailable("Grouping requires unique bounded region IDs, roles and rectangles.");
  const document = validateLogoVectorDocument(base), choices = command.data.regions;
  const rectangles = choices.map(region => rectangle(region.bounds));
  for (let a = 0; a < rectangles.length; a++) for (let b = a + 1; b < rectangles.length; b++) {
    if (overlaps(rectangles[a]!, rectangles[b]!)) return unavailable("Grouping rectangles must not overlap. Give each whole path one unambiguous region.");
  }
  const flattened = flattenLogoPaths(document);
  const entries: Entry[] = [], membership: Entry[][] = choices.map(() => []), touched = new Set<string>();
  for (const component of document.components) for (const path of component.paths) {
    const index = entries.length, bounds = pathBounds(flattened[index]!);
    const entry: Entry = { component, path, index, region: null };
    if (bounds) for (let region = 0; region < rectangles.length; region++) {
      if (contains(rectangles[region]!, bounds)) {
        if (entry.region !== null) return unavailable("A whole path belongs to more than one region. Adjust the region edges.");
        entry.region = region;
      } else if (overlaps(rectangles[region]!, bounds)) {
        return unavailable("A region cuts across a whole or compound path. Enclose the entire path, or keep the fused artwork together.");
      }
    }
    if (entry.region !== null) { membership[entry.region]!.push(entry); touched.add(component.id); }
    entries.push(entry);
  }
  if (membership.some(items => items.length === 0)) return unavailable("Every region must enclose at least one complete existing path.");
  if (entries.some(entry => touched.has(entry.component.id) && entry.region === null)) {
    return unavailable("Every path in an affected component needs a region. Add regions for the remaining paths before grouping.");
  }
  const existing = new Map(document.components.map(component => [component.id, component]));
  const groups = choices.map((region, index): LogoVectorComponent => {
    const selected = membership[index]!, first = selected[0]!.component;
    if (selected.some((entry, position) => position > 0 && entry.index !== selected[position - 1]!.index + 1)) {
      return unavailable("These paths are interleaved in the drawing order. Grouping them would reorder artwork; keep them together or choose different regions.");
    }
    const wholeSource = selected.length === first.paths.length && selected.every(entry => entry.component.id === first.id);
    if (existing.has(region.id) && !(wholeSource && region.id === first.id)) {
      return unavailable("A grouping ID already identifies different artwork. Use a new unique component ID.");
    }
    if (wholeSource && region.id === first.id && region.role === first.role) return first;
    if (selected.some(entry => entry.component.editingKind === "editable_text")) {
      return unavailable("Editable text must retain its complete text and font source. Group the other artwork separately.");
    }
    if (selected.some(entry => {
      const transform = entry.component.transform, original = first.transform;
      return transform.x !== original.x || transform.y !== original.y || transform.scale !== original.scale || transform.rotation !== original.rotation;
    })) return unavailable("Components with different transforms cannot be combined without rewriting geometry. Group them separately.");
    return {
      id: region.id, role: region.role,
      editingKind: region.role === "lettering" || selected.some(entry => entry.component.editingKind === "outlined_custom") ? "outlined_custom" : "geometry",
      transform: { ...first.transform }, paths: selected.map(entry => entry.path),
    };
  });
  const components: LogoVectorComponent[] = [], emitted = new Set<number>();
  for (const component of document.components) {
    if (!touched.has(component.id)) { components.push(component); continue; }
    for (const entry of entries.filter(item => item.component.id === component.id)) {
      const region = entry.region!;
      if (!emitted.has(region)) { components.push(groups[region]!); emitted.add(region); }
    }
  }
  if (components.length > VECTOR_LIMITS.components) return unavailable("Grouping would exceed the 64-component limit. Use fewer regions.");
  return validateLogoVectorDocument({ ...document, components });
}
