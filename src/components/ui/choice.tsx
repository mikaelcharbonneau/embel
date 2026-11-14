"use client";

import { useId, type ReactNode } from "react";
import { Button, IconButton, Spinner } from "./button";
import { MediaFrame, type MediaRatio, type MediaState } from "./media-frame";

/**
 * Choice cards: the one look for "this is my choice" across the journey. A chosen card is marked by a 2 px ring
 * only, never a tick or radio circle, and keeps its size and place (owner decisions, November 13).
 */

/** A named group of choices; the legend says whether to choose one or several. */
export function ChoiceGroup({
  legend,
  hint,
  columns = 2,
  hideLegend = false,
  describedBy,
  className,
  children,
}: {
  legend: ReactNode;
  /** "Choose one" or "Choose any that apply". */
  hint?: ReactNode;
  /** 1: one large card per row at compact width, three wider; 2: two, then three; "list": one card per row. */
  columns?: 1 | 2 | "list";
  hideLegend?: boolean;
  /** The id of a visible hint shown outside the legend, so the legend alone names the group. */
  describedBy?: string;
  className?: string;
  children: ReactNode;
}) {
  const grid =
    columns === "list"
      ? "e-stack e-stack--md"
      : columns === 1
        ? "e-grid-choices e-grid-choices--large"
        : "e-grid-choices";
  return (
    <fieldset className={["e-stack e-stack--md", className].filter(Boolean).join(" ")} aria-describedby={describedBy}>
      <legend className={hideLegend ? "e-sr" : "e-field__label"}>
        {legend}
        {hint ? <span className="e-field__hint"> {hint}</span> : null}
      </legend>
      <div className={grid}>{children}</div>
    </fieldset>
  );
}

/** A text choice: a real radio or checkbox inside the card, which is its label. The title names the input; the
 * description and any details describe it. */
export function ChoiceCard({
  name,
  value,
  title,
  description,
  leading,
  children,
  checked,
  multiple = false,
  disabled = false,
  busy = false,
  error = false,
  onChange,
}: {
  name: string;
  value: string;
  title: ReactNode;
  description?: ReactNode;
  /** A small picture before the text (a competitor's site icon). */
  leading?: ReactNode;
  /** More about the option under its description; phrasing content only, since it sits inside the label. */
  children?: ReactNode;
  checked: boolean;
  multiple?: boolean;
  disabled?: boolean;
  /** Saving the choice: a spinner in the corner. */
  busy?: boolean;
  error?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  const classes = [
    "e-choice",
    multiple && "e-choice--multiple",
    error && "e-choice--error",
    leading ? "e-choice--leading" : null,
  ]
    .filter(Boolean)
    .join(" ");
  const described = [description ? `${id}-desc` : null, children ? `${id}-more` : null].filter(Boolean).join(" ");
  return (
    <label className={classes} aria-busy={busy || undefined}>
      <input
        type={multiple ? "checkbox" : "radio"}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        aria-labelledby={`${id}-title`}
        aria-describedby={described || undefined}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="e-choice__mark" aria-hidden="true">
        {busy ? <Spinner /> : null}
      </span>
      {leading ? <span className="e-choice__leading">{leading}</span> : null}
      <span className="e-choice__title" id={`${id}-title`}>
        {title}
      </span>
      {description ? (
        <span className="e-choice__desc" id={`${id}-desc`}>
          {description}
        </span>
      ) : null}
      {children ? (
        <span className="e-choice__more" id={`${id}-more`}>
          {children}
        </span>
      ) : null}
    </label>
  );
}

type Artwork = {
  /** The picture's accessible name, such as "Concept 2". */
  label: string;
  src?: string;
  alt?: string;
  ratio?: MediaRatio;
  state?: MediaState;
  contain?: boolean;
  inset?: boolean;
  /** Drawing status label ("Drawing"). */
  status?: string;
  selected: boolean;
  busy?: boolean;
  onEnlarge?: () => void;
  /** Failed: the one sentence inside the frame ("Concept 3 couldn't be drawn."). */
  failedText?: string;
};

/** An image choice with its label and a real Choose button (direction boards, inspiration tiles). */
export function ImageChoice({
  label,
  src,
  alt,
  ratio = "1x1",
  state,
  contain,
  inset,
  status,
  selected,
  busy = false,
  failedText,
  onEnlarge,
  onChoose,
  details,
}: Artwork & { onChoose: () => void; details?: ReactNode }) {
  return (
    <article
      className="e-choice e-choice--image"
      data-selected={selected || undefined}
      aria-busy={busy || undefined}
      aria-label={label}
    >
      <MediaFrame
        ratio={ratio}
        src={src}
        alt={alt ?? label}
        state={state}
        contain={contain}
        inset={inset}
        label={label}
        status={status}
        failedText={failedText}
      />
      {onEnlarge && state !== "drawing" ? (
        <span className="e-choice__enlarge">
          <IconButton icon="maximize-2" label={`Enlarge ${label}`} variant="on-artwork" size="sm" onClick={onEnlarge} />
        </span>
      ) : null}
      <span className="e-choice__mark" aria-hidden="true">
        {busy ? <Spinner /> : null}
      </span>
      <div className="e-choice__foot">
        <div className="e-stack e-stack--xs">
          <span className="e-choice__title">{label}</span>
          {details}
        </div>
        <Button
          size="sm"
          variant={selected ? "secondary" : "primary"}
          aria-pressed={selected}
          loading={busy}
          onClick={onChoose}
        >
          {selected ? "Chosen" : "Choose"}
        </Button>
      </div>
    </article>
  );
}

/**
 * Artwork only (logo concepts in the side chat): no label row and no Choose button. The whole picture is a toggle
 * button named after the concept; Enlarge stays in the corner. Choosing is not final: Send commits it.
 */
export function ArtworkChoice({
  label,
  src,
  alt,
  ratio = "1x1",
  state,
  contain = true,
  inset = true,
  status,
  selected,
  busy = false,
  failedText,
  onEnlarge,
  onChoose,
  disabled = false,
  mediaClassName,
  overlay,
}: Artwork & {
  onChoose: () => void;
  /** The choice cannot be made or saved right now (another choice is saving): the picture stays, its button is off. */
  disabled?: boolean;
  /** Extra classes on the media frame, such as the reveal (`e-media--revealing`). */
  mediaClassName?: string;
  /** Parts drawn inside the media frame over the picture, such as the reveal's handles and labels. */
  overlay?: ReactNode;
}) {
  const ready = state === undefined || state === "loaded";
  return (
    <div className="e-choice e-choice--image" data-selected={selected || undefined} aria-busy={busy || undefined}>
      <MediaFrame
        ratio={ratio}
        src={src}
        alt={alt ?? ""}
        state={state}
        contain={contain}
        inset={inset}
        label={label}
        status={status}
        failedText={failedText}
        className={mediaClassName}
      >
        {overlay}
      </MediaFrame>
      {ready ? (
        <button
          type="button"
          className="e-choice__hit"
          aria-label={label}
          aria-pressed={selected}
          disabled={disabled}
          onClick={onChoose}
        />
      ) : null}
      {ready && onEnlarge ? (
        <span className="e-choice__enlarge">
          <IconButton icon="maximize-2" label={`Enlarge ${label}`} variant="on-artwork" size="sm" onClick={onEnlarge} />
        </span>
      ) : null}
      <span className="e-choice__mark" aria-hidden="true">
        {busy ? <Spinner /> : null}
      </span>
    </div>
  );
}
