"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { prefersReducedMotion, revealImage, type RevealStage } from "./vendor/image-reveal";
import styles from "./logo-reveal.module.css";

export type LogoReveal = {
  /** Classes for the tile's media frame while it reveals (`e-media--revealing`) or fades in (`e-media--reveal`). */
  className: string | undefined;
  /** While revealing: the stage the status label names ("Sketch 42/108", "Screen 423 dots", "Colour 64%"). */
  status: string | null;
  revealing: boolean;
  /** Seen drawing and not revealed yet: the tile keeps its drawing frame while the picture loads. */
  arriving: boolean;
};

/**
 * A logo concept that arrives while its tile is on screen draws itself from its own pixels (transitions.dev's
 * Generative effect, "image" variant, about 3 seconds). Only a tile seen drawing reveals: concepts that are already
 * there when the page opens just show. With reduced motion the picture fades in.
 *
 * `host` holds the tile; the hook finds its `.e-media` frame and picture. The picture must be same-origin or a blob
 * (private logo previews are verified blob URLs), or its pixels cannot be read.
 */
export function useLogoReveal(host: RefObject<HTMLElement | null>, drawing: boolean, ready: boolean): LogoReveal {
  const [seenDrawing, setSeenDrawing] = useState(drawing);
  const [phase, setPhase] = useState<"idle" | "revealing" | "fading" | "done">("idle");
  const [status, setStatus] = useState<string | null>(null);
  if (drawing && !seenDrawing) setSeenDrawing(true);
  // A new round in the same tile (More concepts, a retry) reveals again.
  if (drawing && phase !== "idle") setPhase("idle");
  if (seenDrawing && ready && !drawing && phase === "idle") setPhase(prefersReducedMotion() ? "fading" : "revealing");

  const run = useRef<{ cancel(): void } | null>(null);
  useEffect(() => {
    if (phase !== "revealing") return;
    const frame = host.current?.querySelector<HTMLElement>(".e-media");
    const img = frame?.querySelector<HTMLImageElement>(":scope > img");
    if (!frame || !img) {
      const timer = setTimeout(() => setPhase("done"), 0);
      return () => clearTimeout(timer);
    }
    let cancelled = false;
    const setStage = (stage: RevealStage, text: string) => {
      frame.dataset.stage = stage;
      setStatus(text);
    };
    // The picture is decoded first, or its sketch and screen would be empty.
    void Promise.resolve()
      .then(() => img.decode?.())
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return;
        const reveal = revealImage(img, {
          parent: frame,
          classes: {
            layer: `e-media__canvas ${styles.layer}`,
            svg: styles.svg!,
            sketch: styles.sketch!,
            wire: styles.wire!,
            head: styles.head!,
          },
          duration: 3000,
          onStage: setStage,
        });
        run.current = reveal;
        void reveal.finished.then(() => {
          if (cancelled) return;
          frame.dataset.stage = "resolve";
          // The picture settles from its blur (the design system's resolve transition) before the frame goes.
          setTimeout(() => {
            if (cancelled) return;
            delete frame.dataset.stage;
            setPhase("done");
          }, 200);
        });
      });
    return () => {
      cancelled = true;
      run.current?.cancel();
      run.current = null;
      delete frame.dataset.stage;
    };
  }, [host, phase]);

  return {
    className:
      phase === "revealing" ? `e-media--revealing ${styles.frame}` : phase === "fading" ? "e-media--reveal" : undefined,
    status: phase === "revealing" ? (status ?? "Sketch") : null,
    revealing: phase === "revealing",
    arriving: seenDrawing && phase === "idle",
  };
}
