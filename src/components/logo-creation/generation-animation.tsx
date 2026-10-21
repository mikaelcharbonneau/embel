"use client";
import dynamic from "next/dynamic";
import { Component, useEffect, useState, type ReactNode } from "react";
import styles from "./generation-animation.module.css";

const ImageFx = dynamic(() => import("img-fx").then(module => module.ImageGeneration), { ssr: false });
export const IMAGE_FX_LOADING_OPTIONS = Object.freeze({ preset: "pixels-organic" as const, theme: "light" as const, pixelScale: .5, strength: 1, autoReveal: false });

/** A shader failure must never hide job status or take down the workspace. */
class EffectBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Decorative loading only. Verified private previews stay in their existing
 * owner-fenced renderer, never the effect library's global image bitmap cache. */
export function GenerationAnimation({ variant, queued = false }: { variant: number; queued?: boolean }) {
  const [motionAllowed, setMotionAllowed] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setMotionAllowed(!media.matches && !document.hidden);
    sync(); media.addEventListener("change", sync); document.addEventListener("visibilitychange", sync);
    return () => { media.removeEventListener("change", sync); document.removeEventListener("visibilitychange", sync); };
  }, []);
  return <div className={styles.stage} data-image-fx-preset={IMAGE_FX_LOADING_OPTIONS.preset} data-generation-animation={Number.isFinite(variant) ? Math.abs(Math.trunc(variant)) % 6 + 1 : 1} aria-label={queued ? "Concept queued" : "Generating concept"} role="status">
    {!queued && motionAllowed && <div className={styles.effect} aria-hidden="true"><EffectBoundary>
      <ImageFx {...IMAGE_FX_LOADING_OPTIONS} className={styles.effectHost} style={{ width: "100%", height: "100%" }}>
        <div className={styles.surface} />
      </ImageFx>
    </EffectBoundary></div>}
    <div className={styles.caption}>{queued ? "Waiting to create" : "Creating your concept"}</div>
  </div>;
}
