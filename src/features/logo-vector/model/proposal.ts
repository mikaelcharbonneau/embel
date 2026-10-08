import {
  LOGO_VECTOR_PROPOSAL_OPERATIONS, logoVectorProposalContextSchema, logoVectorProposalPayloadSchema,
  type LogoVectorProposalComponent, type LogoVectorProposalContext, type LogoVectorProposalOperation, type LogoVectorProposalPayload,
} from "../../../domain/logo-vector-proposals";
import type { LogoTransform } from "../../../domain/logo-vector";
import type { LogoPaintedBounds } from "./geometry";
import { LogoVectorError } from "./errors";

const unsupported = (message: string): never => { throw new LogoVectorError("unsupported_edit", message); };
const locked = (): never => { throw new LogoVectorError("locked_component_changed", "The proposal could alter a saved locked component. Its original artwork is preserved."); };
const noChange = (): never => unsupported("The command makes no supported change. Return an explicit no_change result instead.");
const sameRotation = (a: number, b: number) => (a - b) % 360 === 0;
const sameTransform = (a: LogoTransform, b: LogoTransform) => a.x === b.x && a.y === b.y && a.scale === b.scale && sameRotation(a.rotation, b.rotation);
const overlaps = (a: LogoPaintedBounds | null, b: LogoPaintedBounds | null) => Boolean(a && b && a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY);

/** Known metadata limits only. Font glyph/axis/feature support still requires the real shaping service. */
function supportsText(component: Omit<LogoVectorProposalComponent, "allowedOperations">): boolean {
  const source = component.text;
  if (component.role !== "lettering" || component.editingKind !== "editable_text" || !source || !source.fontVersionId || component.paint.status !== "uniform" || !component.paint.textUniform) return false;
  const directions: Record<string, string> = { Latn: "ltr", Grek: "ltr", Cyrl: "ltr", Arab: "rtl", Hebr: "rtl" };
  if (source.faceIndex !== 0 || source.shapingEngine.id !== "harfbuzzjs" || source.shapingEngine.version !== "1.6.2" || directions[source.script] !== source.direction) return false;
  if (/[\p{Control}\p{Format}\p{Line_Separator}\p{Paragraph_Separator}\p{Surrogate}]/u.test(source.text)) return false;
  try { new Intl.Locale(source.language); } catch { return false; }
  return source.script !== "Arab" || source.letterSpacing === 0;
}
/** Capabilities describe provisional command eligibility, not the result of shaping or lock validation. */
export function getLogoVectorProposalComponentOperations(component: Omit<LogoVectorProposalComponent, "allowedOperations">, isLocked: boolean): LogoVectorProposalOperation[] {
  if (isLocked || component.paintedBounds === null) return [];
  return LOGO_VECTOR_PROPOSAL_OPERATIONS.filter(operation => {
    if (operation === "color") return component.paint.status === "uniform";
    if (operation === "font") return supportsText(component);
    if (operation === "spacing") return supportsText(component) && component.text!.script !== "Arab";
    return true;
  });
}
function transformedBounds(component: LogoVectorProposalComponent, transform: LogoTransform): LogoPaintedBounds | null {
  const bounds = component.localPaintedBounds;
  if (!bounds) return null;
  const angle = transform.rotation * Math.PI / 180, cosine = Math.cos(angle) * transform.scale, sine = Math.sin(angle) * transform.scale;
  const corners = [[bounds.minX, bounds.minY], [bounds.minX, bounds.maxY], [bounds.maxX, bounds.minY], [bounds.maxX, bounds.maxY]] as const;
  const points = corners.map(([x, y]) => ({ x: x * cosine - y * sine + transform.x, y: x * sine + y * cosine + transform.y }));
  return { minX: Math.min(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxX: Math.max(...points.map(p => p.x)), maxY: Math.max(...points.map(p => p.y)) };
}
/** Conservative metadata guard only. The authenticated materializer must run actual saved-lock/geometry checks again. */
function checkKnownLockConflicts(context: LogoVectorProposalContext, changed: ReadonlySet<string>, transforms: ReadonlyMap<string, LogoTransform>, order: readonly string[]): void {
  for (const lock of context.locks) {
    const index = context.components.findIndex(component => component.id === lock.componentId), protectedComponent = context.components[index]!;
    if (changed.has(lock.componentId) || order[index] !== lock.componentId) return locked();
    for (const component of context.components) if (changed.has(component.id)) {
      const after = transforms.has(component.id) ? transformedBounds(component, transforms.get(component.id)!) : component.paintedBounds;
      if (overlaps(protectedComponent.paintedBounds, component.paintedBounds) || overlaps(protectedComponent.paintedBounds, after)) return locked();
    }
  }
}

/** Returns frozen provisional intent only. It cannot authenticate context or prove natural-language intent fidelity. */
export function validateLogoVectorProposal(payload: unknown, context: LogoVectorProposalContext): LogoVectorProposalPayload {
  const contextResult = logoVectorProposalContextSchema.safeParse(context), result = logoVectorProposalPayloadSchema.safeParse(payload);
  if (!contextResult.success) throw new LogoVectorError("source_mismatch", "Use the exact frozen context from verified owned vector reads.");
  if (!result.success) return unsupported("The proposal must contain exactly one bounded allowed command or an explicit unsupported result.");
  const frozen = contextResult.data, proposal = result.data;
  if (proposal.status === "unsupported") return proposal;
  const edit = proposal.edit, byId = new Map(frozen.components.map(component => [component.id, component]));
  const requireTarget = (id: string) => {
    const component = byId.get(id);
    if (!component || !frozen.targetComponentIds.includes(id)) return unsupported("The edit must name an actual selected component.");
    if (frozen.locks.some(lock => lock.componentId === id)) return locked();
    // Recompute capabilities; a serialized advertisement is not edit authority.
    if (!getLogoVectorProposalComponentOperations(component, false).includes(edit.kind)) return unsupported("This component does not support the requested control.");
    return component;
  };
  const changed = new Set<string>(), transforms = new Map<string, LogoTransform>();
  let order = frozen.components.map(component => component.id);
  if (edit.kind === "arrangement") {
    if (edit.order.length !== frozen.components.length || edit.order.some(id => !byId.has(id))) return unsupported("Arrangement must preserve every actual component exactly once.");
    order = edit.order;
    edit.order.forEach((id, index) => { if (frozen.components[index]!.id !== id) { requireTarget(id); changed.add(id); } });
    for (const placement of edit.placements) {
      const component = requireTarget(placement.componentId);
      // Saved lock digests hash raw transforms. Never drop a -180/+180 rewrite from a multi-placement command.
      if (sameTransform(component.transform, placement.transform) && component.transform.rotation !== placement.transform.rotation) return unsupported("Preserve exact unchanged transform values rather than rewriting an equivalent rotation.");
      if (!sameTransform(component.transform, placement.transform)) { changed.add(component.id); transforms.set(component.id, placement.transform); }
    }
  } else {
    const component = requireTarget(edit.componentId);
    if (edit.kind === "size") {
      if (edit.scale === component.transform.scale) return noChange();
      transforms.set(component.id, { ...component.transform, scale: edit.scale });
    } else if (edit.kind === "rotation") {
      if (sameRotation(edit.degrees, component.transform.rotation)) return noChange();
      transforms.set(component.id, { ...component.transform, rotation: edit.degrees });
    } else if (edit.kind === "color") {
      if (component.paint.status !== "uniform") return unsupported("Nonuniform painting cannot be recolored without losing the original palette.");
      if ((edit.fill === null) !== (component.paint.fill === null) || (edit.stroke === null) !== (component.paint.stroke === null)) return unsupported("Recoloring must preserve every existing and absent paint channel.");
      if (edit.fill === component.paint.fill && edit.stroke === component.paint.stroke) return noChange();
    } else {
      const source = component.text!;
      if (edit.kind === "font") {
        const font = frozen.fonts.find(item => item.id === edit.fontVersionId);
        if (!font) return unsupported("Choose an exact permitted font from the frozen owned catalog.");
        if (font.id === source.fontVersionId || font.fontContentHash === source.fontContentHash) return noChange();
      } else {
        if (edit.lineHeight !== source.lineHeight) return unsupported("Line-height changes are unavailable for single-line lettering.");
        if (edit.letterSpacing === source.letterSpacing) return noChange();
      }
      // Existing overlap is already a known lock conflict. New glyph extents still require exact candidate validation.
      changed.add(component.id);
      checkKnownLockConflicts(frozen, changed, transforms, order);
      return proposal;
    }
    changed.add(component.id);
  }
  if (!changed.size) return noChange();
  checkKnownLockConflicts(frozen, changed, transforms, order);
  return proposal;
}
