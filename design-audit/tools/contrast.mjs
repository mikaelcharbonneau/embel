// Design-audit contrast calculator (WCAG 2.x relative luminance). No dependencies.
//
//   node design-audit/tools/contrast.mjs "#696965" "#f7f7f5"            -> one pair
//   node design-audit/tools/contrast.mjs "rgba(25,25,25,.55)" "#fff"    -> a translucent colour is composited first
//   import { ratio, parse, over } from "./contrast.mjs"                 -> use from another script
//
// Thresholds: normal text 4.5:1, large text (>= 24 px, or >= 18.66 px bold) 3:1, UI parts and focus rings 3:1.

/** "#rgb", "#rrggbb", "#rrggbbaa", "rgb(...)", "rgba(...)" (comma or space syntax, % alpha) -> [r, g, b, a] */
export function parse(input) {
  const text = String(input).trim().toLowerCase();
  if (text === "transparent") return [0, 0, 0, 0];
  if (text.startsWith("#")) {
    let hex = text.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join("");
    const n = (i) => parseInt(hex.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), hex.length === 8 ? n(6) / 255 : 1];
  }
  const m = text.match(/^rgba?\(([^)]+)\)$/u);
  if (!m) throw new Error(`Cannot parse colour: ${input}`);
  const parts = m[1].split(/[\s,/]+/u).filter(Boolean);
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  return [parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]), alpha];
}

/** Composite a (possibly translucent) colour over an opaque one. */
export function over(top, bottom) {
  const [r, g, b, a] = top;
  return [0, 1, 2].map((i) => [r, g, b][i] * a + bottom[i] * (1 - a)).concat(1);
}

export function luminance([r, g, b]) {
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contrast ratio of foreground on background (both strings or parsed arrays). */
export function ratio(foreground, background) {
  const bg = Array.isArray(background) ? background : parse(background);
  let fg = Array.isArray(foreground) ? foreground : parse(foreground);
  if (fg[3] < 1) fg = over(fg, bg);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

export const round = (value) => Math.floor(value * 100) / 100; // never round a failing ratio up to a pass

if (import.meta.url === `file://${process.argv[1]}`) {
  const [fg, bg] = process.argv.slice(2);
  if (!fg || !bg) {
    console.error('usage: node design-audit/tools/contrast.mjs "<foreground>" "<background>"');
    process.exit(1);
  }
  const value = ratio(fg, bg);
  console.log(
    `${fg} on ${bg}: ${round(value)}:1  (text 4.5: ${value >= 4.5 ? "pass" : "FAIL"} · large text / UI 3: ${value >= 3 ? "pass" : "FAIL"})`,
  );
}
