"use client";

import type { ReactNode } from "react";
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
  children,
}: {
  legend: ReactNode;
  /** "Choose one" or "Choose any that apply". */
  hint?: ReactNode;
  columns?: 1 | 2;
  hideLegend?: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset className="e-stack e-stack--md">
      <legend className={hideLegend ? "e-sr" : "e-field__label"}>
        {legend}
        {hint ? <span className="e-field__hint"> {hint}</span> : null}
      </legend>
      <div className={columns === 1 ? "e-grid-choices e-grid-choices--large" : "e-grid-choices"}>{children}</div>
    </fieldset>
  );
}

/** A text choice: a real radio or checkbox inside the card, which is its label. */
export function ChoiceCard({
  name,
  value,
  title,
  description,
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
  checked: boolean;
  multiple?: boolean;
  disabled?: boolean;
  /** Saving the choice: a spinner in the corner. */
  busy?: boolean;
  error?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const classes = ["e-choice", multiple && "e-choice--multiple", error && "e-choice--error"].filter(Boolean).join(" ");
  return (
    <label className={classes} aria-busy={busy || undefined}>
      <input
        type={multiple ? "checkbox" : "radio"}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="e-choice__mark" aria-hidden="true">
        {busy ? <Spinner /> : null}
      </span>
      <span className="e-choice__title">{title}</span>
      {description ? <span className="e-choice__desc">{description}</span> : null}
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
  onEnlarge,
  onChoose,
}: Artwork & { onChoose: () => void }) {
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
      />
      {ready ? (
        <button type="button" className="e-choice__hit" aria-label={label} aria-pressed={selected} onClick={onChoose} />
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
