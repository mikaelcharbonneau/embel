"use client";

import { useEffect, useRef } from "react";
import type { StepReply } from "./model/step-reply";

/**
 * Reports a step's reply-box state to its owner only when what it shows changes. The functions it hands over always
 * call the step's latest ones, so the owner can keep them without re-rendering on every step render.
 */
export function useStepReply(reply: StepReply | null, onChange: ((reply: StepReply | null) => void) | undefined) {
  const latest = useRef(reply);
  const report = useRef(onChange);
  useEffect(() => {
    latest.current = reply;
    report.current = onChange;
  });
  const key = reply
    ? JSON.stringify({ ...reply, chips: reply.chips.map(({ id, label, onRemove }) => [id, label, Boolean(onRemove)]) })
    : null;
  const stoppable = Boolean(reply?.stop);
  useEffect(() => {
    const current = latest.current;
    if (!current) {
      report.current?.(null);
      return;
    }
    report.current?.({
      ...current,
      chips: current.chips.map((chip) => ({
        ...chip,
        onRemove: chip.onRemove
          ? () => latest.current?.chips.find((item) => item.id === chip.id)?.onRemove?.()
          : undefined,
      })),
      send: (text) => latest.current?.send(text),
      stop: stoppable ? () => latest.current?.stop?.() : undefined,
    });
  }, [key, stoppable]);
  useEffect(() => () => report.current?.(null), []);
}
