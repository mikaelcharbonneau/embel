import type { ReactNode } from "react";
import styles from "./brand-application-mockups.module.css";

/** Presentation-only devices and print materials around the exact selected artwork. */
// No reviewed marketing-copy source exists yet. These layout placeholders must
// not consume project briefs, activity descriptions or creative instructions.
export function WebsiteMockup({ name, logo }: { name: string; logo: ReactNode }) {
  return <div className={styles.websiteScene} data-application-mockup="website"><div className={styles.laptop}>
    <div className={styles.screen}><div className={styles.browserBar}><span className={styles.trafficLights} aria-hidden="true"><i /><i /><i /></span><span className={styles.address}>Website preview</span><span className={styles.browserMenu} aria-hidden="true">•••</span></div>
      <div className={styles.site}><div className={styles.siteNav}><div className={styles.siteLogo}>{logo}</div><span>About&nbsp;&nbsp; Contact</span><span className={styles.navAction}>Discover ↗</span></div>
        <div className={styles.siteHero}><span className={styles.siteEyebrow}>Introducing {name}</span><h3>{name}</h3><p>Your brand introduction goes here.</p><span className={styles.siteButton}>Explore {name}<span aria-hidden="true">↗</span></span></div>
        <div className={styles.siteFooter}><span>{name}</span><span>Website concept</span></div>
      </div>
    </div><div className={styles.laptopBase} aria-hidden="true"><i /></div>
  </div></div>;
}

export function SocialMockup({ name, logo }: { name: string; logo: ReactNode }) {
  return <div className={styles.socialScene} data-application-mockup="social"><div className={styles.phone}>
    <div className={styles.phoneScreen}><div className={styles.statusBar} aria-hidden="true"><span>9:41</span><i /><span>▰</span></div>
      <div className={styles.feedHeader}><span className={styles.avatar}>{name.charAt(0)}</span><div><strong>{name}</strong><span>Brand announcement</span></div><b aria-hidden="true">···</b></div>
      <div className={styles.postArtwork}><div className={styles.postLogo}>{logo}</div><h3>Your announcement goes here.</h3><span className={styles.postBrand}>{name}</span></div>
      <div className={styles.postActions} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" /></svg><svg viewBox="0 0 24 24"><path d="M21 11.5a9 9 0 0 1-9.5 9 9.5 9.5 0 0 1-4-.9L3 21l1.4-4.5a9.5 9.5 0 0 1-.9-4A9 9 0 0 1 12.5 3H13a9 9 0 0 1 8 8.5Z" /></svg><svg viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4Z M22 2 11 13" /></svg><svg className={styles.bookmark} viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4Z" /></svg></div>
      <div className={styles.postCaption}><strong>{name}</strong><span>Your message goes here.</span></div><div className={styles.phoneHome} aria-hidden="true" />
    </div>
  </div></div>;
}

export function StationeryMockup({ name, logo }: { name: string; logo: ReactNode }) {
  return <div className={styles.stationeryScene} data-application-mockup="stationery"><div className={styles.cardPair}>
    <div className={styles.cardBack} aria-hidden="true"><span>{name}</span><i /></div>
    <div className={styles.cardFront}><div className={styles.printLogo}>{logo}</div><div className={styles.printFooter}><span>{name}</span><i /></div></div>
  </div></div>;
}
