import { SaxesParser } from "saxes";
import type { LogoVectorDocument, LogoVectorPath } from "../../../domain/logo-vector";
import {
  canonicalizeLogoPath,
  encodeLogoPath,
  flattenLogoPaths,
  validateLogoVectorDocument,
  type Affine,
} from "./geometry";
import { LogoVectorError } from "./errors";
import { assertVectorByteLimit, assertVectorCount, VECTOR_LIMITS } from "./limits";

const SVG_NS = "http://www.w3.org/2000/svg";
const NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
const numberList = new RegExp(`^${NUMBER}(?:(?:\\s*,\\s*|\\s+)${NUMBER})*$`);
const unitless = new RegExp(`^${NUMBER}$`);
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const identity: Affine = [1, 0, 0, 1, 0, 0];
const unsupported = (reason: string): never => {
  throw new LogoVectorError("unsupported_svg", reason);
};
const invalid = (reason: string): never => {
  throw new LogoVectorError("invalid_geometry", reason);
};

function numbers(value: string): number[] {
  const trimmed = value.trim();
  if (!numberList.test(trimmed)) return invalid("SVG numeric attributes must be finite supported numbers.");
  const values = trimmed.split(/[\s,]+/).map(Number);
  if (values.some((number) => !Number.isFinite(number) || Math.abs(number) > VECTOR_LIMITS.coordinate))
    return invalid("SVG numeric attributes exceed the supported range.");
  return values;
}
function number(value: string, minimum: number, maximum: number): number {
  if (!unitless.test(value.trim())) return invalid("SVG numeric attribute is malformed.");
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum)
    return invalid("SVG numeric attribute exceeds its supported range.");
  return result;
}
function dimension(value: string): number {
  const stripped = value.trim().replace(/px$/, "");
  if (!unitless.test(stripped)) return unsupported("Root dimensions support only positive unitless or px values.");
  const parsed = number(stripped, 0, VECTOR_LIMITS.dimension);
  if (parsed <= 0) return invalid("Root dimensions must be positive.");
  return parsed;
}
function color(value: string): string | null {
  if (value === "none") return null;
  if (value === "black") return "#000000";
  if (value === "white") return "#FFFFFF";
  if (/^#[\da-f]{6}$/i.test(value)) return value.toUpperCase();
  if (/^#[\da-f]{3}$/i.test(value))
    return (
      "#" +
      [...value.slice(1)]
        .map((part) => part + part)
        .join("")
        .toUpperCase()
    );
  return unsupported("Paint supports only solid RGB hex, black, white or none.");
}
function multiply(a: Affine, b: Affine): Affine {
  const result: Affine = [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  if (result.some((value) => !Number.isFinite(value) || Math.abs(value) > VECTOR_LIMITS.coordinate))
    return invalid("Composed SVG transform exceeds the supported range.");
  return result;
}
function transform(value: string): Affine {
  let result = identity,
    index = 0;
  const expression = /([A-Za-z]+)\s*\(([^()]*)\)/gy;
  while (index < value.length) {
    while (/\s/.test(value[index] ?? "") && index < value.length) index++;
    if (index === value.length) break;
    expression.lastIndex = index;
    const match = expression.exec(value);
    if (!match) return unsupported("SVG transform syntax is unsupported.");
    index = expression.lastIndex;
    const args = numbers(match[2]!);
    let local: Affine;
    if (match[1] === "matrix" && args.length === 6) local = args as unknown as Affine;
    else if (match[1] === "translate" && (args.length === 1 || args.length === 2))
      local = [1, 0, 0, 1, args[0]!, args[1] ?? 0];
    else if (match[1] === "scale" && (args.length === 1 || args.length === 2))
      local = [args[0]!, 0, 0, args[1] ?? args[0]!, 0, 0];
    else if (match[1] === "rotate" && (args.length === 1 || args.length === 3)) {
      const angle = (args[0]! * Math.PI) / 180,
        cosine = Math.cos(angle),
        sine = Math.sin(angle),
        x = args[1] ?? 0,
        y = args[2] ?? 0;
      local = [cosine, sine, -sine, cosine, x - cosine * x + sine * y, y - sine * x - cosine * y];
    } else return unsupported("Only matrix, translate, scale and rotate transforms are supported.");
    if (local[0] * local[3] - local[1] * local[2] === 0) return invalid("A transform must not collapse the artwork.");
    result = multiply(result, local);
  }
  return result;
}

type Paint = {
  fill: string | null;
  fillOpacity: number;
  stroke: string | null;
  strokeWidth: number;
  strokeOpacity: number;
  linecap: "butt" | "round" | "square";
  linejoin: "miter" | "round" | "bevel";
  miterLimit: number;
  fillRule: "nonzero" | "evenodd";
};
const defaultPaint: Paint = {
  fill: "#000000",
  fillOpacity: 1,
  stroke: null,
  strokeWidth: 1,
  strokeOpacity: 1,
  linecap: "butt",
  linejoin: "miter",
  miterLimit: 4,
  fillRule: "nonzero",
};
const paintAttributes = new Set([
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "fill-rule",
  "opacity",
]);
function paintFor(parent: Paint, attrs: Record<string, string>): Paint {
  const paint = { ...parent };
  if (attrs.opacity !== undefined && number(attrs.opacity, 0, 1) !== 1)
    return unsupported("Isolated opacity is unsupported; preserve alpha in individual path paint.");
  if (attrs.fill !== undefined) paint.fill = color(attrs.fill);
  if (attrs.stroke !== undefined) paint.stroke = color(attrs.stroke);
  if (attrs["fill-opacity"] !== undefined) paint.fillOpacity = number(attrs["fill-opacity"], 0, 1);
  if (attrs["stroke-opacity"] !== undefined) paint.strokeOpacity = number(attrs["stroke-opacity"], 0, 1);
  if (attrs["stroke-width"] !== undefined)
    paint.strokeWidth = number(attrs["stroke-width"], 0, VECTOR_LIMITS.strokeWidth);
  if (attrs["stroke-miterlimit"] !== undefined)
    paint.miterLimit = number(attrs["stroke-miterlimit"], 1, VECTOR_LIMITS.miterLimit);
  if (attrs["stroke-linecap"] !== undefined) {
    const value = attrs["stroke-linecap"];
    if (value !== "butt" && value !== "round" && value !== "square") return unsupported("Unsupported stroke cap.");
    paint.linecap = value;
  }
  if (attrs["stroke-linejoin"] !== undefined) {
    const value = attrs["stroke-linejoin"];
    if (value !== "miter" && value !== "round" && value !== "bevel") return unsupported("Unsupported stroke join.");
    paint.linejoin = value;
  }
  if (attrs["fill-rule"] !== undefined) {
    const value = attrs["fill-rule"];
    if (value !== "evenodd" && value !== "nonzero") return unsupported("Unsupported fill rule.");
    paint.fillRule = value;
  }
  return paint;
}

type Frame = { tag: string; matrix: Affine; paint: Paint };
/** Strict passive XML ingestion. The returned geometry is not publication or ownership proof. */
export function validateLogoVectorSvg(svg: Uint8Array): LogoVectorDocument {
  assertVectorByteLimit(svg);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(svg);
  } catch {
    return unsupported("SVG must contain valid UTF-8 XML.");
  }
  const stack: Frame[] = [],
    paths: LogoVectorPath[] = [];
  const ids = new Set<string>();
  let viewBox: LogoVectorDocument["viewBox"] | undefined,
    commandCount = 0,
    pathSequence = 0,
    rootSeen = false;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", () => unsupported("SVG XML is malformed."));
  parser.on("doctype", () => unsupported("DOCTYPE and entity declarations are unsupported."));
  parser.on("processinginstruction", () => unsupported("SVG processing instructions are unsupported."));
  parser.on("cdata", () => unsupported("SVG CDATA is unsupported."));
  parser.on("xmldecl", (declaration) => {
    if ((declaration.encoding && declaration.encoding.toLowerCase() !== "utf-8") || declaration.version !== "1.0")
      unsupported("Only UTF-8 XML 1.0 is supported.");
  });
  parser.on("text", (text) => {
    const tag = stack.at(-1)?.tag;
    if (text.trim() && tag !== "title" && tag !== "desc")
      unsupported("Text nodes cannot become editable vector artwork.");
  });
  parser.on("opentag", (tag) => {
    assertVectorCount(stack.length + 1, VECTOR_LIMITS.xmlDepth, "XML depth");
    if (tag.uri !== SVG_NS || !["svg", "g", "path", "title", "desc"].includes(tag.local))
      unsupported("Only passive SVG groups and paths are supported.");
    const parent = stack.at(-1);
    if (parent && ["path", "title", "desc"].includes(parent.tag))
      unsupported("This SVG element cannot contain child elements.");
    if (tag.local === "svg" && (parent || rootSeen)) unsupported("Nested SVG documents are unsupported.");
    if (!parent && tag.local !== "svg") unsupported("The root must be an SVG element.");
    const attrs: Record<string, string> = {};
    for (const attr of Object.values(tag.attributes)) {
      if (attr.name === "xmlns" && attr.value === SVG_NS) continue;
      if (attr.uri || attr.prefix) unsupported("Namespaced SVG attributes are unsupported.");
      const allowed =
        attr.name === "id" ||
        ((tag.local === "g" || tag.local === "path") && attr.name === "transform") ||
        ((tag.local === "svg" || tag.local === "g" || tag.local === "path") && paintAttributes.has(attr.name)) ||
        (tag.local === "svg" && ["viewBox", "width", "height", "version"].includes(attr.name)) ||
        (tag.local === "path" && attr.name === "d");
      if (!allowed) unsupported("SVG contains an unsupported attribute.");
      attrs[attr.name] = attr.value;
    }
    if (attrs.id !== undefined) {
      if (!identifier.test(attrs.id) || ids.has(attrs.id)) unsupported("SVG identifiers must be supported and unique.");
      ids.add(attrs.id);
    }
    if (tag.local === "svg") {
      rootSeen = true;
      if (attrs.version !== undefined && attrs.version !== "1.1" && attrs.version !== "1.0")
        unsupported("Unsupported SVG version.");
      const width = attrs.width === undefined ? undefined : dimension(attrs.width);
      const height = attrs.height === undefined ? undefined : dimension(attrs.height);
      if (attrs.viewBox !== undefined) {
        const box = numbers(attrs.viewBox);
        if (
          box.length !== 4 ||
          box[2]! <= 0 ||
          box[3]! <= 0 ||
          box[2]! > VECTOR_LIMITS.dimension ||
          box[3]! > VECTOR_LIMITS.dimension
        )
          invalid("SVG viewBox requires finite positive supported dimensions.");
        viewBox = box as LogoVectorDocument["viewBox"];
      } else if (width !== undefined && height !== undefined) viewBox = [0, 0, width, height];
      else invalid("SVG needs a viewBox or finite positive root dimensions.");
    }
    const matrix = multiply(
      parent?.matrix ?? identity,
      attrs.transform === undefined ? identity : transform(attrs.transform),
    );
    const paint = paintFor(parent?.paint ?? defaultPaint, attrs);
    stack.push({ tag: tag.local, matrix, paint });
    if (tag.local !== "path") return;
    assertVectorCount(paths.length + 1, VECTOR_LIMITS.paths, "path count");
    if (!attrs.d?.trim()) invalid("SVG path data is required.");
    const parsed = canonicalizeLogoPath(attrs.d!, matrix);
    commandCount += parsed.commands.length;
    assertVectorCount(commandCount, VECTOR_LIMITS.commands, "command count");
    const scaleX = Math.hypot(matrix[0], matrix[1]),
      scaleY = Math.hypot(matrix[2], matrix[3]);
    if (
      paint.stroke &&
      (Math.abs(scaleX - scaleY) > Math.max(scaleX, scaleY) * 1e-12 ||
        Math.abs(matrix[0] * matrix[2] + matrix[1] * matrix[3]) > scaleX * scaleY * 1e-12)
    )
      unsupported("Nonuniform or sheared strokes must be outlined before import.");
    const strokeWidth = paint.strokeWidth * scaleX;
    if (!Number.isFinite(strokeWidth) || strokeWidth > VECTOR_LIMITS.strokeWidth)
      invalid("Transformed stroke exceeds the supported width.");
    let id = attrs.id;
    if (!id) {
      do {
        id = `imported-path-${++pathSequence}`;
      } while (ids.has(id));
      ids.add(id);
    }
    paths.push({
      id,
      d: encodeLogoPath(parsed),
      fillRule: paint.fillRule,
      fill: paint.fill ? { color: paint.fill, opacity: paint.fillOpacity } : null,
      stroke: paint.stroke
        ? {
            color: paint.stroke,
            opacity: paint.strokeOpacity,
            width: strokeWidth,
            linecap: paint.linecap,
            linejoin: paint.linejoin,
            miterLimit: paint.miterLimit,
          }
        : null,
    });
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  try {
    for (let offset = 0; offset < source.length; offset += 4096) parser.write(source.slice(offset, offset + 4096));
    parser.close();
  } catch (error) {
    if (error instanceof LogoVectorError) throw error;
    return unsupported("SVG XML is malformed or unsupported.");
  }
  if (!paths.length) throw new LogoVectorError("empty_artwork", "SVG contains no supported vector paths.");
  if (!viewBox) return invalid("SVG viewBox is missing.");
  return validateLogoVectorDocument({
    version: 1,
    viewBox,
    components: [
      {
        id: "imported-artwork",
        role: "whole_artwork",
        editingKind: "geometry",
        paths,
        transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      },
    ],
  });
}

const escapeAttribute = (value: string | number) =>
  String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export function serializeLogoSvg(document: LogoVectorDocument): Uint8Array {
  const validated = validateLogoVectorDocument(document);
  const paths = flattenLogoPaths(validated).map((path) => {
    const attributes: Record<string, string | number> = {
      id: path.id,
      d: path.d,
      fill: path.fill?.color ?? "none",
      "fill-rule": path.fillRule,
    };
    if (path.fill) attributes["fill-opacity"] = path.fill.opacity;
    attributes.stroke = path.stroke?.color ?? "none";
    if (path.stroke)
      Object.assign(attributes, {
        "stroke-width": path.stroke.width,
        "stroke-opacity": path.stroke.opacity,
        "stroke-linecap": path.stroke.linecap,
        "stroke-linejoin": path.stroke.linejoin,
        "stroke-miterlimit": path.stroke.miterLimit,
      });
    return `<path ${Object.entries(attributes)
      .map(([name, value]) => `${name}="${escapeAttribute(value)}"`)
      .join(" ")}/>`;
  });
  const bytes = new TextEncoder().encode(
    `<svg xmlns="${SVG_NS}" viewBox="${validated.viewBox.join(" ")}">${paths.join("")}</svg>`,
  );
  assertVectorByteLimit(bytes);
  return bytes;
}
