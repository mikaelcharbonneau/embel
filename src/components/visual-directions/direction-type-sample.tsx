"use client";

import { useEffect, useState } from "react";
import { brandBoardFont, brandTextDirection, supportedBrandBoardTypography, type BrandBoardFont } from "@/domain/brand-board-fonts";
import styles from "./direction-type-sample.module.css";

type TypeStyle = { family: string; weight: number; style: string };

function LoadedSample({ font, weight, brandName }: { font: BrandBoardFont; weight: number; brandName: string }) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  const family = `EmbelDirection_${font.id.replaceAll("-", "_")}`;

  useEffect(() => {
    let active = true;
    let face: FontFace | undefined;
    // Stop showing a pending sample if the local font request stalls.
    const timer = window.setTimeout(() => {
      active = false;
      setState("failed");
    }, 15_000);
    async function load() {
      try {
        face = new FontFace(family, `url("${font.file}")`, { style: "normal", weight: `${font.minWeight} ${font.maxWeight}` });
        await face.load();
        if (!active) return;
        if (face.status !== "loaded") throw new Error("Font did not load");
        document.fonts.add(face);
        setState("loaded");
      } catch {
        if (active) setState("failed");
      } finally {
        window.clearTimeout(timer);
      }
    }
    void load();
    return () => {
      active = false;
      window.clearTimeout(timer);
      if (face) document.fonts?.delete(face);
    };
  }, [family, font]);

  if (state !== "loaded") return <span className={styles.note}>{state === "loading" ? "Loading type sample…" : "Type sample unavailable"}</span>;
  return <bdi className={styles.sample} dir={brandTextDirection(brandName)} style={{ fontFamily: family, fontWeight: weight }}>{brandName}</bdi>;
}

export function DirectionTypeSample({ style, brandName }: { style: TypeStyle; brandName: string }) {
  const font = brandBoardFont(style.family);
  const supported = font && brandName.trim() && supportedBrandBoardTypography(style, brandName);
  return <div className={styles.specimen}>
    <span className={styles.caption}>{style.family} · {style.weight}{style.style !== "normal" && ` · ${style.style}`}</span>
    {supported ? <LoadedSample key={font.id} font={font} weight={style.weight} brandName={brandName} />
      : <span className={styles.note}>Type sample unavailable</span>}
  </div>;
}
