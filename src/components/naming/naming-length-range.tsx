"use client";

import { useId, useRef, type PointerEvent } from "react";
import type { NamingPreferencesV2 } from "@/domain/naming-brain-preferences";
import styles from "./naming-length-range.module.css";

type Bounds = Pick<NamingPreferencesV2, "minimumGraphemes" | "maximumGraphemes">;
type Bound = keyof Bounds;
const low: Bound = "minimumGraphemes",
  high: Bound = "maximumGraphemes";
const limits = { min: 1, mid: 20, max: 160 } as const;
// Give short names enough room to adjust on a phone. The middle tick labels the scale change.
const position = (n: number) =>
  n <= limits.mid
    ? (n - limits.min) / (limits.mid - limits.min) / 2
    : 0.5 + (n - limits.mid) / (limits.max - limits.mid) / 2;
const lengthAt = (fraction: number) =>
  Math.round(
    fraction <= 0.5
      ? limits.min + 2 * fraction * (limits.mid - limits.min)
      : limits.mid + (fraction - 0.5) * 2 * (limits.max - limits.mid),
  );

export function NamingLengthRange({
  value,
  disabled,
  onChange,
}: {
  value: Bounds;
  disabled: boolean;
  onChange: (value: Partial<Bounds>) => void;
}) {
  const help = useId(),
    rail = useRef<HTMLDivElement>(null);
  const lower = useRef<HTMLInputElement>(null),
    upper = useRef<HTMLInputElement>(null);
  const drag = useRef<{ id: number; bound: Bound | null; offset: number; start: number } | null>(null);
  const min = value.minimumGraphemes ?? limits.min,
    max = value.maximumGraphemes ?? limits.max;
  const flexible = value.minimumGraphemes === null && value.maximumGraphemes === null;
  function setBound(bound: Bound, n: number) {
    const next = bound === low ? Math.max(limits.min, Math.min(max, n)) : Math.min(limits.max, Math.max(min, n));
    if (!disabled && next !== value[bound]) onChange({ [bound]: next });
  }
  function focus(bound: Bound) {
    (bound === low ? lower : upper).current?.focus({ preventScroll: true });
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current,
      box = rail.current?.getBoundingClientRect();
    if (disabled || !box?.width || !active || event.pointerId !== active.id) return;
    if (!active.bound) {
      if (event.clientX === active.start) return;
      active.bound = event.clientX < active.start ? low : high;
      focus(active.bound);
    }
    setBound(active.bound, lengthAt((event.clientX - active.offset - box.left) / box.width));
  }
  function start(event: PointerEvent<HTMLDivElement>) {
    const box = rail.current?.getBoundingClientRect();
    if (disabled || drag.current || event.button !== 0 || !box?.width) return;
    const x = event.clientX,
      minX = box.left + position(min) * box.width,
      maxX = box.left + position(max) * box.width;
    const nearest = Math.abs(x - minX) <= Math.abs(x - maxX) ? low : high;
    const delta = x - (nearest === low ? minX : maxX);
    const grabbed = Math.abs(delta) <= 14;
    // When the thumbs meet, dragging left opens the minimum and right opens the maximum.
    const bound = grabbed && min === max ? null : nearest;
    drag.current = { id: event.pointerId, bound, offset: grabbed ? delta : 0, start: x };
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (bound) focus(bound);
    if (!grabbed) move(event);
  }
  const count = (n: number) => `${n} ${n === 1 ? "character" : "characters"}`;
  const summary = flexible
    ? "Flexible"
    : value.minimumGraphemes === null
      ? `Up to ${count(max)}`
      : value.maximumGraphemes === null
        ? `At least ${count(min)}`
        : min === max
          ? count(min)
          : `${min}–${max} characters`;

  return (
    <fieldset className={styles.group} disabled={disabled}>
      <legend>Name length</legend>
      <div className={styles.readout}>
        <span>{summary}</span>
        <button
          type="button"
          disabled={disabled || flexible}
          onClick={() => onChange({ minimumGraphemes: null, maximumGraphemes: null })}
        >
          Reset length
        </button>
      </div>
      <div
        className={styles.control}
        onPointerDown={start}
        onPointerMove={move}
        onLostPointerCapture={(event) => {
          if (drag.current?.id === event.pointerId) drag.current = null;
        }}
      >
        <div ref={rail} className={styles.rail}>
          <span
            className={styles.selected}
            style={{ left: `${position(min) * 100}%`, right: `${(1 - position(max)) * 100}%` }}
          />
          {([low, high] as const).map((bound) => {
            const isMin = bound === low,
              n = isMin ? min : max;
            return (
              <label key={bound} className={styles.thumb} style={{ left: `${position(n) * 100}%` }}>
                <input
                  ref={isMin ? lower : upper}
                  type="range"
                  aria-label={isMin ? "Minimum characters" : "Maximum characters"}
                  aria-describedby={help}
                  aria-keyshortcuts="Delete Backspace"
                  aria-valuetext={value[bound] === null ? (isMin ? "No minimum" : "No maximum") : count(n)}
                  min={isMin ? limits.min : min}
                  max={isMin ? max : limits.max}
                  value={n}
                  step={1}
                  onChange={(event) => setBound(bound, event.currentTarget.valueAsNumber)}
                  onKeyDown={(event) => {
                    if (event.key === "Delete" || event.key === "Backspace") {
                      event.preventDefault();
                      onChange({ [bound]: null });
                    }
                  }}
                />
              </label>
            );
          })}
        </div>
      </div>
      <div className={styles.ticks} aria-hidden="true">
        <span>1</span>
        <span>20</span>
        <span>160</span>
      </div>
      <p id={help} className={styles.hint}>
        Leave either end flexible, or set a limit. Count combined letters and emoji as whole characters.
        <span className="sr-only"> Use arrow keys to adjust a limit or Delete to clear it.</span>
      </p>
    </fieldset>
  );
}
