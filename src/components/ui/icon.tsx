import type { CSSProperties } from "react";

/**
 * The design system's icon family: Lucide (ISC licence) on a 24 px grid at a 1.5 stroke, drawn as CSS masks
 * by `.e-icon[data-icon=…]` in src/styles/embel/components.css, so an icon always takes the text colour.
 */
export const lucideIcons = [
  "house",
  "folder",
  "library",
  "images",
  "image",
  "image-off",
  "plus",
  "minus",
  "search",
  "arrow-right",
  "arrow-left",
  "arrow-up",
  "arrow-down",
  "arrow-up-down",
  "chevron-down",
  "chevron-right",
  "chevron-left",
  "chevron-up",
  "check",
  "x",
  "ellipsis",
  "trash-2",
  "pencil",
  "refresh-cw",
  "rotate-ccw",
  "undo-2",
  "mic",
  "heart",
  "eye",
  "eye-off",
  "download",
  "copy",
  "maximize-2",
  "external-link",
  "info",
  "triangle-alert",
  "circle-alert",
  "circle-check",
  "lock",
  "wifi-off",
  "square",
  "settings",
  "log-out",
  "user",
  "clock",
  "sliders-horizontal",
  "layers",
  "palette",
  "type",
  "file-text",
  "link",
  "credit-card",
  "upload",
  "columns-2",
  "panel-left-close",
  "panel-left-open",
  "zap",
] as const;
export type LucideIconName = (typeof lucideIcons)[number];

/** Names used before the design system; each now draws its Lucide equivalent. */
const aliases = {
  home: "house",
  brands: "folder",
  assets: "images",
  team: "user",
  arrow: "arrow-right",
  chevron: "chevron-right",
  close: "x",
  menu: "ellipsis",
  file: "file-text",
  device: "columns-2",
  trash: "trash-2",
  offline: "wifi-off",
  refresh: "refresh-cw",
} as const satisfies Record<string, LucideIconName>;
export type IconName = LucideIconName | keyof typeof aliases;

/** The three sizes the system allows: 16 (inside buttons and meta lines), 20 (default) and 24 (empty states). */
export type IconSize = "sm" | "md" | "lg";
const sizeFromPixels = (px: number): IconSize => (px <= 17 ? "sm" : px <= 21 ? "md" : "lg");

export function Icon({
  name,
  size = "md",
  muted = false,
  className,
  style,
}: {
  name: IconName;
  /** A named size, or a pixel size from older callers, rounded to the nearest allowed size. */
  size?: IconSize | number;
  muted?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const icon = name in aliases ? aliases[name as keyof typeof aliases] : (name as LucideIconName);
  const step = typeof size === "number" ? sizeFromPixels(size) : size;
  const classes = ["e-icon", step === "md" ? "" : `e-icon--${step}`, muted ? "e-icon--muted" : "", className ?? ""];
  return <span aria-hidden="true" data-icon={icon} className={classes.filter(Boolean).join(" ")} style={style} />;
}

/** The Embel mark, a single-ink shape in the text colour, at 24 px or larger. */
export function EmbelMark({ className }: { className?: string }) {
  return <span aria-hidden="true" className={className ? `e-mark ${className}` : "e-mark"} />;
}
