import type { CSSProperties, ReactNode } from "react";
import type { InspirationChoice } from "@/domain/inspiration";
import type { LogoType } from "@/domain/logo-workspace";
import { brandBoardDirection } from "./brand-board-direction";
import { WebsiteMockup, SocialMockup, StationeryMockup } from "./brand-application-mockups";
import styles from "./brand-board.module.css";

export function BrandBoardSystem({ name, logoType, choices, logo, logoNeedsReview = false }: { name: string; logoType: LogoType; choices: readonly InspirationChoice[]; logo: ReactNode; logoNeedsReview?: boolean }) {
  const direction = brandBoardDirection(choices, logoType);
  const tokens = { "--board-primary": direction.primary.hex, "--board-accent": direction.accent.hex, "--board-weight": direction.type.headingWeight, "--board-tracking": direction.type.tracking } as CSSProperties;
  return <div className={styles.system} style={tokens} data-brand-board-layout>
    <section className={`${styles.tile} ${styles.logoTile}`} aria-label="Selected brand logo" aria-describedby="board-logo-status">
      <h2>Project logo choice</h2><div className={styles.logoStage}>{logo}</div><span id="board-logo-status" className={styles.tileNote}>{name} · Saved selection{logoNeedsReview && " · Review changed inputs"}</span><p className={styles.tileNote}>This preview uses your project’s logo choice. Vector approval and asset-library selections are separate.</p>
    </section>
    <section className={`${styles.tile} ${styles.paletteTile}`} aria-labelledby="board-palette" aria-describedby="board-palette-source">
      <div className={styles.tileHeading}><h2 id="board-palette">Proposed palette</h2><span id="board-palette-source">{direction.paletteSource === "saved_inspiration" ? "From saved inspiration" : "Neutral starting point"}</span></div>
      <div className={styles.leadColors}>{direction.palette.slice(0, 2).map((color, index) => <article key={color.hex} className={styles.swatch} style={{ background: color.hex, color: color.foreground }} aria-label={`${color.name}, ${color.hex}, ${color.role}`}><h3>{index === 0 ? "Primary" : "Accent"}</h3><code>{color.hex}</code></article>)}</div>
      <div className={styles.neutralColors}>{direction.palette.slice(2).map(color => <article key={color.hex} aria-label={`${color.name}, ${color.hex}, ${color.role}`}><i style={{ background: color.hex }} aria-hidden="true" /><div><h3>{color.name}</h3><span>{color.role.split(" · ")[0]}</span></div><code>{color.hex}</code></article>)}</div>
    </section>
    <section className={`${styles.tile} ${styles.typeTile}`} aria-labelledby="board-type" aria-describedby="board-type-source">
      <div className={styles.tileHeading}><h2 id="board-type">Proposed typography</h2><span id="board-type-source">{direction.type.family} · Default preview</span></div>
      <div className={styles.typeSpecimen}><div><span className={styles.typeRole}>Heading · {direction.type.headingWeight === 700 ? "Bold 700" : "Semibold 600"}</span><h3>A clear direction.</h3></div><div><span className={styles.typeRole}>Body · Regular 400</span><p>The quick brown fox jumps over the lazy dog.</p></div><div className={styles.typeCharacters}>Aa Bb Cc &amp; 0123456789</div></div>
      <div className={styles.typeScale}>Labels · Medium 500</div>
    </section>
    <section className={`${styles.tile} ${styles.webTile}`} aria-labelledby="board-web" aria-describedby="board-web-status">
      <WebsiteMockup name={name} logo={logo} />
      <div className={styles.applicationCaption}><h2 id="board-web">Website landing page</h2><span id="board-web-status">Application preview · Placeholder copy</span></div>
    </section>
    <section className={`${styles.tile} ${styles.socialTile}`} aria-labelledby="board-social" aria-describedby="board-social-status">
      <SocialMockup name={name} logo={logo} />
      <div className={styles.applicationCaption}><h2 id="board-social">Social announcement</h2><span id="board-social-status">Application preview · Placeholder copy</span></div>
    </section>
    <section className={`${styles.tile} ${styles.cardTile}`} aria-labelledby="board-card" aria-describedby="board-card-status">
      <StationeryMockup name={name} logo={logo} />
      <div className={styles.applicationCaption}><h2 id="board-card">Business card</h2><span id="board-card-status">Application preview</span></div>
    </section>
  </div>;
}
