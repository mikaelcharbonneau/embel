import "server-only";
import { createHash } from "node:crypto";
import {
  logoLocksSchema,
  type LogoComponentLock,
  type LogoVectorComponent,
  type LogoVectorDocument,
} from "../../../domain/logo-vector";
import {
  canonicalizeLogoPath,
  encodeLogoPath,
  getLogoComponentPaintedBounds,
  validateLogoVectorDocument,
  type LogoPaintedBounds,
} from "./geometry";
import { LogoVectorError } from "./errors";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const changed = (): never => {
  throw new LogoVectorError(
    "locked_component_changed",
    "The change could alter a locked component. Save a separate explicit unlock before changing it.",
  );
};
function digest(component: LogoVectorComponent, index: number): LogoComponentLock {
  const geometryHash = hash(
    component.paths.map((path) => ({ id: path.id, d: encodeLogoPath(canonicalizeLogoPath(path.d)) })),
  );
  const appearanceHash = hash(
    component.paths.map((path) => ({ id: path.id, fill: path.fill, stroke: path.stroke, fillRule: path.fillRule })),
  );
  const transformHash = hash(component.transform);
  const textHash = hash(component.editingKind === "editable_text" ? component.textSource : null);
  const zOrderHash = hash(index);
  const fields = { componentId: component.id, geometryHash, appearanceHash, transformHash, textHash, zOrderHash };
  return { ...fields, effectiveHash: hash({ ...fields, role: component.role, editingKind: component.editingKind }) };
}
function overlaps(a: LogoPaintedBounds | null, b: LogoPaintedBounds | null): boolean {
  return Boolean(a && b && a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY);
}
/** Authoritative callers resolve component IDs from the actual saved lock intent. */
export function captureLogoComponentLocks(
  document: LogoVectorDocument,
  componentIds: readonly string[],
): readonly LogoComponentLock[] {
  const validated = validateLogoVectorDocument(document);
  if (componentIds.length > 64 || new Set(componentIds).size !== componentIds.length) return changed();
  return Object.freeze(
    componentIds.map((id) => {
      const index = validated.components.findIndex((component) => component.id === id);
      if (index < 0) return changed();
      return Object.freeze(digest(validated.components[index]!, index));
    }),
  );
}

/** Requires the CURRENT database lock set. An omitted client lock set is never authority. */
export function assertLogoComponentLocks(
  base: LogoVectorDocument,
  candidate: LogoVectorDocument,
  locks: readonly LogoComponentLock[],
): void {
  if (!logoLocksSchema.safeParse(locks).success) return changed();
  const validatedBase = validateLogoVectorDocument(base);
  let validatedCandidate: LogoVectorDocument;
  try {
    validatedCandidate = validateLogoVectorDocument(candidate);
  } catch (error) {
    if (locks.length) return changed();
    throw error;
  }
  // Root canvas mapping changes effective placement even when component paths are identical.
  if (locks.length && validatedBase.viewBox.some((value, index) => value !== validatedCandidate.viewBox[index]))
    return changed();
  const before = new Map(
    validatedBase.components.map((component, index) => [
      component.id,
      { digest: digest(component, index), bounds: getLogoComponentPaintedBounds(component) },
    ]),
  );
  const after = new Map(
    validatedCandidate.components.map((component, index) => [
      component.id,
      { digest: digest(component, index), bounds: getLogoComponentPaintedBounds(component) },
    ]),
  );
  for (const lock of locks) {
    const original = before.get(lock.componentId),
      proposed = after.get(lock.componentId);
    if (
      !original ||
      !proposed ||
      canonical(original.digest) !== canonical(lock) ||
      canonical(proposed.digest) !== canonical(original.digest)
    )
      return changed();
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (id === lock.componentId) continue;
      const oldOther = before.get(id),
        newOther = after.get(id);
      if (overlaps(original.bounds, oldOther?.bounds ?? null) || overlaps(proposed.bounds, newOther?.bounds ?? null)) {
        if (!oldOther || !newOther || oldOther.digest.effectiveHash !== newOther.digest.effectiveHash) return changed();
      }
    }
  }
}

/** Raw raster refinement capability only; this does not establish provider availability. */
export function getVectorRefinementCapability(
  locks: readonly LogoComponentLock[],
): { status: "available" } | { status: "unavailable"; reason: "unsupported_locked_refinement" } {
  return locks.length ? { status: "unavailable", reason: "unsupported_locked_refinement" } : { status: "available" };
}
