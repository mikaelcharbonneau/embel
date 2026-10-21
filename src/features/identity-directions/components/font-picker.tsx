"use client";
import { ContextDetails } from "@/components/ui/context-details";

import { useId } from "react";
import type { FontPermission, FontPurpose, FontRecord, IdentityTypographyVersion } from "@/domain/logo-directions";
import { canonicalIdentityInput } from "../model/font-check-binding";
import type { FontPreviewReader } from "../model/font-preview";
import { OwnedFontPreview } from "./owned-font-preview";
import { useFontPreviewReader } from "./font-preview-provider";
import styles from "./identity-directions.module.css";

const purposes: readonly [FontPurpose, string][] = [["render", "Display"], ["outline", "Create outlines"], ["embed", "Embed"], ["modify", "Modify font"], ["redistribute", "Share font files"]];
const permission = (value: FontPermission, reviewed: boolean) => reviewed ? value === "allowed" ? "Allowed" : value === "denied" ? "Not permitted" : "Unverified"
  : value === "allowed" ? "Declared allowed · unreviewed" : value === "denied" ? "Declared not permitted" : "Unverified";

export function FontPicker({ typography, fonts, showActions = false, readPreview }: { typography: IdentityTypographyVersion | null; fonts: readonly FontRecord[]; showActions?: boolean; readPreview?: FontPreviewReader }): React.JSX.Element {
  const noticeId = useId();
  const connectedReader = useFontPreviewReader();
  return <div className={styles.fonts}>
    {!typography ? <p className={styles.caption}>No typography has been selected.</p> : typography.styles.map(style => {
      const matching = fonts.filter(font => font.id === style.fontVersionId && font.asset.ownerId === typography.ownerId && font.asset.projectId === typography.projectId);
      const font = matching.length === 1 ? matching[0] : undefined;
      const reviewed = font?.rights.sourceKind === "reviewed_license";
      return <section className={styles.fontStyle} key={style.key} aria-label={style.role + " font"}>
        <div className={styles.headingRow}><strong>{style.role} · {font?.family ?? "Font unavailable"}</strong><span>{style.sizePx} px</span></div>
        <p className={styles.caption}>Weight {style.weight} · {style.style} · line height {style.lineHeight}</p>
        <p className={styles.caption}>Exact specimen: “{style.sampleText}”</p>
        {font && <OwnedFontPreview key={canonicalIdentityInput({ ownerId: typography.ownerId, projectId: typography.projectId, typographyVersionId: typography.id, font, style })} font={font} style={style} readPreview={readPreview ?? connectedReader} />}
        <p className={styles.version}>Font version: {style.fontVersionId}</p>
        {font ? <ContextDetails  title={<>Usage permissions</>}><p className={styles.caption}>{reviewed ? "Reviewed license" : "User declaration · license not reviewed"}</p><dl className={styles.permissions}>
            <div><dt>Commercial use</dt><dd>{permission(font.rights.commercialUse, reviewed)}</dd></div>
            {purposes.map(([purpose, label]) => <div key={purpose}><dt>{label}</dt><dd>{permission(font.rights.permissions[purpose], reviewed)}</dd></div>)}
          </dl></ContextDetails> : <p className={styles.caption}>Permissions and character coverage are unavailable for this font.</p>}
      </section>;
    })}
    {showActions && <><div className={styles.actions}><button type="button" disabled aria-describedby={noticeId}>Choose font</button><button type="button" disabled aria-describedby={noticeId}>Upload font</button></div>
      <p id={noticeId} className={styles.caption}>Font changes and uploads need connected owned storage. Free-commercial catalog fonts have individual usage receipts; uploaded fonts require their actual license and review. Paid fonts are not offered.</p></>}
  </div>;
}
