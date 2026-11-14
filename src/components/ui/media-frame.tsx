/* eslint-disable @next/next/no-img-element -- generated images are private, signed and already sized; next/image adds nothing here */
import type { ReactNode } from "react";
import { Icon } from "./icon";

export type MediaRatio = "1x1" | "4x5" | "16x9" | "8x11" | "4x3" | "3x1" | "4x1";
export type MediaState = "loaded" | "loading" | "failed" | "private" | "drawing";

/**
 * A fixed-ratio box for a generated or uploaded image. Logos use contain on paper (their own background is kept),
 * boards and photos use cover. Failed shows an icon and one sentence; the retry button sits beside the frame.
 * Drawing is a logo concept still being made: a dotted frame with corner handles and two mono labels.
 */
export function MediaFrame({
  ratio = "1x1",
  src,
  alt,
  state = src ? "loaded" : "loading",
  contain = false,
  inset = false,
  label,
  status,
  failedText = "This image couldn't be shown.",
  className,
  onImageError,
  children,
}: {
  ratio?: MediaRatio;
  src?: string;
  /** Required with a picture: what it shows ("Concept 2 for Kestrel Analytics"). Empty only for decorative copies. */
  alt?: string;
  state?: MediaState;
  contain?: boolean;
  /** The logo sits 12% inside its tile. */
  inset?: boolean;
  /** Drawing: what the tile is ("Concept 3"). */
  label?: string;
  /** Drawing: what is happening ("Drawing"). */
  status?: string;
  failedText?: string;
  className?: string;
  /** The picture failed to load (an expired private link): the owner shows the failed state instead. */
  onImageError?: () => void;
  /** Controls drawn on the image, such as an on-artwork Enlarge button. */
  children?: ReactNode;
}) {
  const classes = [
    "e-media",
    ratio === "1x1" ? "" : `e-media--${ratio}`,
    contain && "e-media--contain",
    inset && "e-media--inset",
    state === "drawing" && "e-media--drawing",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  if (state === "drawing")
    return (
      <div className={classes} role="img" aria-label={label ? `${label} is being drawn` : "Being drawn"}>
        <span className="e-media__handles" aria-hidden="true" />
        {label ? (
          <span className="e-media__label" aria-hidden="true">
            {label}
          </span>
        ) : null}
        <span className="e-media__status" aria-hidden="true">
          {status ?? "Drawing"}
        </span>
        {children}
      </div>
    );
  if (state === "loading") return <div className={classes} data-state="loading" aria-hidden="true" />;
  if (state === "failed" || state === "private")
    return (
      <div className={classes} data-state={state}>
        <Icon name={state === "private" ? "lock" : "image-off"} />
        <span>{state === "private" ? "This preview is private." : failedText}</span>
        {children}
      </div>
    );
  return (
    <div className={classes}>
      <img src={src} alt={alt ?? ""} onError={onImageError} />
      {children}
    </div>
  );
}
