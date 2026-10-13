"use client";

import type { LogoRasterSource } from "../../domain/logo-workspace";
import type { AccountLogoClient } from "../identity/account-logo-client";
import type { VerifiedAccount } from "../workspace/account-session";
import { logoCandidateKey } from "./candidate-review";
import { useLogoCandidate } from "./use-logo-candidate";
import { LogoVerifiedPreview } from "./verified-preview";
import { LOGO_TYPE_LABELS } from "./presentation";
import styles from "./logo-creation.module.css";

type Props = { client: AccountLogoClient; account: VerifiedAccount; projectId: string; sources: LogoRasterSource[];
  selected: LogoRasterSource | null; briefRevisionId?: string;
  onRemove(source: LogoRasterSource): void; onSelect?: (source: LogoRasterSource) => void };

export function LogoCandidateComparison(props: Props) {
  if (!props.sources.length) return null;
  return <section className={styles.panel} aria-label="Compare saved logos" data-logo-comparison tabIndex={-1}>
    <h2>Compare saved logos</h2>
    <p className={styles.note}>Compare two saved versions. Your current selection and all previous versions stay unchanged until you choose a version.</p>
    <div className={styles.comparison}>
      {props.sources.slice(0, 2).map((source, index) => <ComparisonCandidate key={logoCandidateKey(source)} {...props} source={source} ordinal={index + 1} />)}
      {props.sources.length === 1 && <div className={styles.comparisonEmpty}><p>Add another concept or refinement to compare.</p></div>}
    </div>
  </section>;
}

function ComparisonCandidate({ client, account, projectId, source, selected, briefRevisionId, onRemove, onSelect, ordinal }: Props & { source: LogoRasterSource; ordinal: number }) {
  const review = useLogoCandidate(client, account, projectId, source);
  const item = review.item;
  const isSelected = Boolean(selected && logoCandidateKey(selected) === logoCandidateKey(source));
  return <article className={styles.conceptCard} aria-label={`Comparison version ${ordinal}`}>
    <div className={styles.cardHeading}><h3>{item?.title ?? "Saved version"}</h3>{isSelected && <span className={styles.badge}>Selected for review</span>}</div>
    {item && <p className={styles.typeLabel}>{LOGO_TYPE_LABELS[item.logoType]} · {source.kind === "concept" ? `Exploration ${source.batchId.slice(-8)}` : `Revision ${source.rasterRevisionId.slice(-8)}`}</p>}
    <div className={styles.preview}>{item ? <LogoVerifiedPreview client={client} receipt={item.preview} alt={`Comparison ${ordinal}: ${item.title}`} />
      : <p role="status">{review.error ? "This saved version could not be verified. Its original record is kept." : "Reading saved version…"}</p>}</div>
    {item?.briefRevisionId && briefRevisionId && item.briefRevisionId !== briefRevisionId && <p className={styles.warning}>Uses an earlier saved brief.</p>}
    {review.error && <button type="button" className={styles.secondaryButton} onClick={review.refresh}>Retry reading version {ordinal}</button>}
    <button type="button" className={styles.primaryButton} aria-label={`Use comparison version ${ordinal}`} aria-pressed={isSelected} disabled={!item || !onSelect} onClick={() => { if (item) onSelect?.(item.source); }}>Use this version</button>
    <button type="button" className={styles.secondaryButton} aria-label={`Remove comparison version ${ordinal}`} onClick={() => onRemove(source)}>Remove from comparison</button>
  </article>;
}
