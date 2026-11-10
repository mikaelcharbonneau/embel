import { SVGPathData, SVGPathDataParser, SVGPathDataTransformer, type SVGCommand } from "svg-pathdata";
import {
  logoJsonBytes,
  logoVectorDocumentSchema,
  type LogoVectorDocument,
  type LogoVectorComponent,
  type LogoVectorPath,
} from "../../../domain/logo-vector";
import { LogoVectorError } from "./errors";
import { assertVectorCount, VECTOR_LIMITS } from "./limits";

export type Affine = readonly [number, number, number, number, number, number];
export type LogoPaintedBounds = { minX: number; minY: number; maxX: number; maxY: number };
const identity: Affine = [1, 0, 0, 1, 0, 0];

function checkCoordinates(commands: readonly SVGCommand[]) {
  for (const command of commands)
    for (const [key, value] of Object.entries(command)) {
      if (
        key !== "type" &&
        typeof value === "number" &&
        (!Number.isFinite(value) || Math.abs(value) > VECTOR_LIMITS.coordinate)
      ) {
        throw new LogoVectorError("invalid_geometry", "Path coordinates exceed the supported range.");
      }
    }
}

/** Uses the pinned parser, including during limit checks; never a substitute path grammar. */
export function canonicalizeLogoPath(d: string, matrix: Affine = identity): SVGPathData {
  try {
    const parser = new SVGPathDataParser();
    const commands: SVGCommand[] = [];
    for (let offset = 0; offset < d.length; offset += 4096) {
      parser.parse(d.slice(offset, offset + 4096), commands);
      assertVectorCount(commands.length, VECTOR_LIMITS.commands, "command count");
    }
    parser.finish(commands);
    assertVectorCount(commands.length, VECTOR_LIMITS.commands, "command count");
    checkCoordinates(commands);
    if (commands.some((command) => command.type === SVGPathData.ARC)) {
      throw new LogoVectorError(
        "unsupported_svg",
        "Elliptical arcs require an exact supported path representation before import.",
      );
    }
    const path = new SVGPathData(commands)
      .toAbs()
      .normalizeST()
      .transform(SVGPathDataTransformer.NORMALIZE_HVZ(false, true, true, false));
    checkCoordinates(path.commands);
    path.matrix(...matrix);
    checkCoordinates(path.commands);
    return path;
  } catch (error) {
    if (error instanceof LogoVectorError) throw error;
    throw new LogoVectorError("invalid_geometry", "Path data is malformed or unsupported.");
  }
}

export function encodeLogoPath(path: SVGPathData): string {
  // The dependency emits lowercase closepath; canonical documents require uppercase Z.
  return path.encode().replaceAll("z", "Z");
}

function componentMatrix(component: LogoVectorComponent): Affine {
  const { x, y, scale, rotation } = component.transform;
  const radians = (rotation * Math.PI) / 180;
  return [
    scale * Math.cos(radians),
    scale * Math.sin(radians),
    -scale * Math.sin(radians),
    scale * Math.cos(radians),
    x,
    y,
  ];
}

function flattenComponent(component: LogoVectorComponent): LogoVectorPath[] {
  return component.paths.map((path) => {
    const width = path.stroke ? path.stroke.width * component.transform.scale : 0;
    if (!Number.isFinite(width) || width > VECTOR_LIMITS.strokeWidth)
      throw new LogoVectorError("invalid_geometry", "Transformed stroke exceeds the supported width.");
    return {
      ...path,
      d: encodeLogoPath(canonicalizeLogoPath(path.d, componentMatrix(component))),
      fill: path.fill ? { ...path.fill } : null,
      stroke: path.stroke ? { ...path.stroke, width } : null,
    };
  });
}

type Polynomial = readonly [number, number, number, number];
type Segment = { x: Polynomial; y: Polynomial };
const evaluate = (p: Polynomial, t: number) => ((p[3] * t + p[2]) * t + p[1]) * t + p[0];
const line = (from: number, to: number): Polynomial => [from, to - from, 0, 0];
const cubic = (p0: number, p1: number, p2: number, p3: number): Polynomial => [
  p0,
  3 * (p1 - p0),
  3 * (p2 - 2 * p1 + p0),
  p3 - 3 * p2 + 3 * p1 - p0,
];
function extrema(p: Polynomial): number[] {
  const a = 3 * p[3],
    b = 2 * p[2],
    c = p[1];
  if (a === 0) return b === 0 ? [] : [-c / b].filter((t) => t > 0 && t < 1);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  return [(-b - Math.sqrt(discriminant)) / (2 * a), (-b + Math.sqrt(discriminant)) / (2 * a)].filter(
    (t) => t > 0 && t < 1,
  );
}
function fillSegments(path: SVGPathData): Segment[] {
  const segments: Segment[] = [];
  let x = 0,
    y = 0,
    startX = 0,
    startY = 0,
    open = false;
  const close = () => {
    if (open && (x !== startX || y !== startY)) segments.push({ x: line(x, startX), y: line(y, startY) });
  };
  const commands = new SVGPathData(path.commands.map((command) => ({ ...command }))).qtToC().commands;
  for (const command of commands) {
    if (command.type === SVGPathData.MOVE_TO) {
      close();
      x = startX = command.x;
      y = startY = command.y;
      open = true;
    } else if (command.type === SVGPathData.CLOSE_PATH) {
      close();
      x = startX;
      y = startY;
    } else if (command.type === SVGPathData.LINE_TO) {
      segments.push({ x: line(x, command.x), y: line(y, command.y) });
      x = command.x;
      y = command.y;
    } else if (command.type === SVGPathData.CURVE_TO) {
      segments.push({ x: cubic(x, command.x1, command.x2, command.x), y: cubic(y, command.y1, command.y2, command.y) });
      x = command.x;
      y = command.y;
    }
  }
  close();
  return segments;
}

/** A positive scanline interval proves filled area; bounds alone do not prove ink. */
function hasFilledArea(path: SVGPathData, fillRule: LogoVectorPath["fillRule"], bounds: LogoPaintedBounds): boolean {
  if (!(bounds.maxX > bounds.minX && bounds.maxY > bounds.minY)) return false;
  const segments = fillSegments(path);
  const samples = new Set<number>([(bounds.minY + bounds.maxY) / 2]);
  for (const segment of segments) {
    const knots = [0, ...extrema(segment.y).sort((a, b) => a - b), 1];
    for (let index = 1; index < knots.length; index++) {
      const low = evaluate(segment.y, knots[index - 1]!),
        high = evaluate(segment.y, knots[index]!);
      if (low !== high) samples.add((low + high) / 2);
    }
    if (samples.size >= 64) break;
  }
  for (const sample of samples) {
    const crossings: { x: number; direction: number }[] = [];
    for (const segment of segments) {
      const knots = [0, ...extrema(segment.y).sort((a, b) => a - b), 1];
      for (let index = 1; index < knots.length; index++) {
        let low = knots[index - 1]!,
          high = knots[index]!;
        const y0 = evaluate(segment.y, low),
          y1 = evaluate(segment.y, high);
        if (sample < Math.min(y0, y1) || sample >= Math.max(y0, y1)) continue;
        for (let step = 0; step < 60; step++) {
          const mid = (low + high) / 2;
          if (evaluate(segment.y, mid) < sample === y0 < y1) low = mid;
          else high = mid;
        }
        crossings.push({ x: evaluate(segment.x, (low + high) / 2), direction: y1 > y0 ? 1 : -1 });
      }
    }
    crossings.sort((a, b) => a.x - b.x);
    let winding = 0,
      parity = 0;
    for (let index = 0; index < crossings.length;) {
      const x = crossings[index]!.x;
      do {
        winding += crossings[index]!.direction;
        parity ^= 1;
        index++;
      } while (index < crossings.length && Math.abs(crossings[index]!.x - x) <= 1e-9);
      if (
        index < crossings.length &&
        crossings[index]!.x - x > 1e-9 &&
        (fillRule === "evenodd" ? parity !== 0 : winding !== 0)
      )
        return true;
    }
  }
  return false;
}

/** A polynomial segment has positive arc length iff its defining points are not all identical. */
function hasNonzeroStrokeSegment(path: SVGPathData): boolean {
  let x = 0,
    y = 0,
    startX = 0,
    startY = 0;
  for (const command of path.commands) {
    if (command.type === SVGPathData.MOVE_TO) {
      x = startX = command.x;
      y = startY = command.y;
    } else if (command.type === SVGPathData.CLOSE_PATH) {
      if (x !== startX || y !== startY) return true;
      x = startX;
      y = startY;
    } else if (
      command.type === SVGPathData.LINE_TO ||
      command.type === SVGPathData.QUAD_TO ||
      command.type === SVGPathData.CURVE_TO
    ) {
      if (command.x !== x || command.y !== y) return true;
      if (
        (command.type === SVGPathData.QUAD_TO || command.type === SVGPathData.CURVE_TO) &&
        (command.x1 !== x || command.y1 !== y)
      )
        return true;
      if (command.type === SVGPathData.CURVE_TO && (command.x2 !== x || command.y2 !== y)) return true;
      x = command.x;
      y = command.y;
    }
  }
  return false;
}

export function getLogoPathPaintedBounds(path: LogoVectorPath): LogoPaintedBounds | null {
  const parsed = canonicalizeLogoPath(path.d);
  const bounds = parsed.getBounds();
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) return null;
  const stroke =
    path.stroke && path.stroke.opacity > 0 && path.stroke.width > 0 && hasNonzeroStrokeSegment(parsed)
      ? path.stroke
      : null;
  const filled = path.fill && path.fill.opacity > 0 && hasFilledArea(parsed, path.fillRule, bounds);
  if (!stroke && !filled) return null;
  // Conservatively enclose every permitted join and cap, including square caps at an angle.
  const extension = stroke
    ? (stroke.width / 2) *
      Math.max(stroke.linejoin === "miter" ? stroke.miterLimit : 1, stroke.linecap === "square" ? Math.SQRT2 : 1)
    : 0;
  return {
    minX: bounds.minX - extension,
    minY: bounds.minY - extension,
    maxX: bounds.maxX + extension,
    maxY: bounds.maxY + extension,
  };
}

export function getLogoComponentPaintedBounds(component: LogoVectorComponent): LogoPaintedBounds | null {
  const bounds = flattenComponent(component)
    .map(getLogoPathPaintedBounds)
    .filter((item): item is LogoPaintedBounds => item !== null);
  if (!bounds.length) return null;
  return bounds.reduce((all, item) => ({
    minX: Math.min(all.minX, item.minX),
    minY: Math.min(all.minY, item.minY),
    maxX: Math.max(all.maxX, item.maxX),
    maxY: Math.max(all.maxY, item.maxY),
  }));
}

export function validateLogoVectorDocument(value: unknown): LogoVectorDocument {
  try {
    if (logoJsonBytes(value) > VECTOR_LIMITS.bytes)
      throw new LogoVectorError("limit_exceeded", "Canonical document exceeds the 8 MiB limit.");
  } catch (error) {
    if (error instanceof LogoVectorError) throw error;
    throw new LogoVectorError("invalid_geometry", "Canonical document must contain finite bounded JSON values.");
  }
  const result = logoVectorDocumentSchema.safeParse(value);
  if (!result.success)
    throw new LogoVectorError("invalid_geometry", "Canonical document violates the shared geometry contract.");
  const document = result.data;
  const [x, y, width, height] = document.viewBox;
  let visible = false,
    commands = 0;
  for (const component of document.components)
    for (const path of flattenComponent(component)) {
      commands += canonicalizeLogoPath(path.d).commands.length;
      assertVectorCount(commands, VECTOR_LIMITS.commands, "command count");
      const bounds = getLogoPathPaintedBounds(path);
      if (!bounds) continue;
      visible = true;
      if (bounds.minX < x || bounds.minY < y || bounds.maxX > x + width || bounds.maxY > y + height) {
        throw new LogoVectorError(
          "invalid_geometry",
          "Painted artwork may extend outside the viewBox; adjust the canvas before continuing.",
        );
      }
    }
  if (!visible)
    throw new LogoVectorError(
      "empty_artwork",
      "No positive-area fill or nonzero-length visible stroke could be verified.",
    );
  return document;
}

export function flattenLogoPaths(document: LogoVectorDocument): readonly LogoVectorPath[] {
  return validateLogoVectorDocument(document).components.flatMap(flattenComponent);
}
