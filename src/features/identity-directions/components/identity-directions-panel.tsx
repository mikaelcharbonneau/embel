"use client";
import { useId } from "react";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import type { IdentityDirectionBasis } from "@/domain/logo-directions";
import type { LogoWorkspaceV2 } from "@/domain/logo-workspace";
import { DirectionCard } from "./direction-card";
import { DirectionGenerationControls } from "./direction-generation";
import { FontPicker } from "./font-picker";
import { FontPreviewProvider } from "./font-preview-provider";
import { useIdentityDirections, type IdentityDirectionsController } from "./use-identity-directions";
import styles from "./identity-directions.module.css";
export function IdentityDirectionsPanel({ workspace, client }: { workspace: LogoWorkspaceV2; client: AccountLogoClient }): React.JSX.Element {
  return <FontPreviewProvider client={client} projectId={workspace.projectId}><IdentityDirectionsView controller={useIdentityDirections(client, workspace)} /></FontPreviewProvider>;
}
/** Shared production view also used by labeled offline interaction fixtures. */
export function IdentityDirectionsView({ controller }: { controller: IdentityDirectionsController }): React.JSX.Element {
  const titleId = useId();
  const current = controller.workspace, overview = controller.overview, selection = overview?.selection ?? null;
  const stale = !!(overview?.stale || current?.staleStages.some(item => item.stage === "directions"));
  const staleFiles = !!current?.staleStages.some(item => item.stage === "deliverables");
  const directions = overview?.directions.filter(direction => controller.directionIds.includes(direction.id)) ?? [];
  const retained = controller.history?.overview ?? overview;
  const retainedDirections = retained?.directions.filter(direction => !controller.directionIds.includes(direction.id)) ?? [];
  const choices = controller.draft?.components ?? selection;
  const checks = controller.draft?.consistency ?? selection?.consistency;
  const exactSaved = !!selection && !!choices && selection.paletteVersionId === choices.paletteVersionId && selection.typographyVersionId === choices.typographyVersionId && selection.graphicsVersionId === choices.graphicsVersionId;
  const resolve = <T extends IdentityDirectionBasis,>(rows: readonly T[], id: string, basis: IdentityDirectionBasis): T | null => {
    const matches = rows.filter(row => row.id === id && row.ownerId === basis.ownerId && row.projectId === basis.projectId && row.approvedLogoId === basis.approvedLogoId && JSON.stringify(row.inputRevisions) === JSON.stringify(basis.inputRevisions));
    return matches.length === 1 ? matches[0]! : null;
  };
  return <section className={styles.panel} aria-labelledby={titleId} aria-busy={controller.loading}>
    <header className={styles.header}><div><p className={styles.eyebrow}>Visual identity</p><h2 id={titleId}>Identity directions</h2><p className={styles.caption}>Colors, typography and graphics around your approved logo.</p></div><span className={styles.badge}>Logo protected</span></header>
    {!controller.canRead ? <p className={styles.notice} role="status">{controller.error ?? "Waiting for your saved workspace. Sign in to view your identity directions."}</p>
      : !current?.approvedLogo ? <div className={styles.empty}><h3>Start with an approved logo</h3><p>Approve your logo in the logo editor before exploring three coordinated identity directions.</p></div>
      : <>
        <div className={styles.headingRow}><p className={styles.caption}>Manual mixing keeps your approved logo unchanged.</p><button type="button" disabled={controller.loading} onClick={() => { void controller.refresh(); }}>{controller.loading ? "Loading…" : "Refresh saved work"}</button></div>
        {controller.error && <p className={styles.notice} role="status">{controller.error}</p>}
        {stale && <p className={styles.warning} role="status">These directions use earlier inputs. Review them against the current logo before approving a new identity.</p>}
        {staleFiles && <p className={styles.warning}>Your brand files use earlier choices and need review before they can be refreshed.</p>}
        <DirectionGenerationControls controller={controller.generation} />
        {directions.length > 0 && overview ? <div className={styles.cards}>{directions.map(direction => <DirectionCard key={direction.id} direction={direction}
          palette={resolve(overview.palettes, direction.paletteVersionId, direction)} typography={resolve(overview.typography, direction.typographyVersionId, direction)} graphics={resolve(overview.graphics, direction.graphicsVersionId, direction)} fonts={overview.fonts}
          selectedParts={(["palette", "typography", "graphics"] as const).filter(part => choices?.[part === "palette" ? "paletteVersionId" : part === "typography" ? "typographyVersionId" : "graphicsVersionId"] === direction[part === "palette" ? "paletteVersionId" : part === "typography" ? "typographyVersionId" : "graphicsVersionId"])}
          stale={stale || direction.approvedLogoId !== current.approvedLogo!.id} approvedLogoDocument={direction.approvedLogoId === current.approvedLogo!.id ? controller.approvedLogoDocument : null}
          onChoose={() => { void controller.preview({ paletteVersionId: direction.paletteVersionId, typographyVersionId: direction.typographyVersionId, graphicsVersionId: direction.graphicsVersionId }); }} disabled={stale || controller.loading || !!controller.pendingRequestKey || controller.pendingGeneration} />)}</div>
          : !controller.loading && overview && <div className={styles.empty}><h3>No current directions yet</h3><p>A completed, current set of three directions will appear here. Earlier retained work stays in history below.</p></div>}
        {(retainedDirections.length > 0 || controller.history?.canLoadMore || controller.history?.canLoadPrevious) && <details className={styles.details}>
          <summary>Retained direction history</summary><p className={styles.caption}>These saved versions are kept for reference. Browsing history does not replace the current choices or approve an earlier result.</p>
          {retained && <div className={styles.cards}>{retainedDirections.map(direction => <DirectionCard key={direction.id} direction={direction}
            palette={resolve(retained.palettes, direction.paletteVersionId, direction)} typography={resolve(retained.typography, direction.typographyVersionId, direction)} graphics={resolve(retained.graphics, direction.graphicsVersionId, direction)} fonts={retained.fonts}
            selectedParts={[]} stale={true} approvedLogoDocument={direction.approvedLogoId === current.approvedLogo!.id ? controller.approvedLogoDocument : null} />)}</div>}
          <div className={styles.actions}>{controller.history?.canLoadPrevious && <button type="button" disabled={controller.history.loading} onClick={() => { void controller.loadHistory("previous"); }}>Previous history page</button>}
            {controller.history?.canLoadMore && <button type="button" disabled={controller.history.loading || controller.loading} onClick={() => { void controller.loadHistory(); }}>{controller.history.loading ? "Loading history…" : "Load earlier directions"}</button>}</div>
          {controller.history?.error && <p className={styles.notice} role="status">{controller.history.error}</p>}
        </details>}
        {overview && directions.length > 0 && <section className={styles.selection} aria-label="Component choices"><div className={styles.headingRow}><h3>Mix components</h3><span className={styles.badge}>{overview.approval && exactSaved && !stale ? "Approved selection" : exactSaved ? "Saved selection" : choices ? "Unsaved preview" : "Choose a direction"}</span></div>
          <div className={styles.componentFields}>{(["palette", "typography", "graphics"] as const).map(part => {
            const field = part === "palette" ? "paletteVersionId" : part === "typography" ? "typographyVersionId" : "graphicsVersionId";
            const rows = part === "palette" ? overview.palettes : part === "typography" ? overview.typography : overview.graphics;
            return <label key={part}>{part}<select disabled={stale || controller.loading || !!controller.pendingRequestKey || controller.pendingGeneration} value={choices?.[field] ?? ""} onChange={event => {
              const first = directions[0]!;
              void controller.preview({ paletteVersionId: choices?.paletteVersionId ?? first.paletteVersionId, typographyVersionId: choices?.typographyVersionId ?? first.typographyVersionId, graphicsVersionId: choices?.graphicsVersionId ?? first.graphicsVersionId, [field]: event.target.value });
            }}><option value="" disabled>Choose {part}</option>{rows.filter(row => row.approvedLogoId === current.approvedLogo!.id && directions.some(d => d[field] === row.id)).map(row => <option key={row.id} value={row.id}>{directions.find(direction => direction[field] === row.id)?.name ?? "Saved component"}</option>)}</select></label>;
          })}</div>
          {checks && <ul className={styles.checks} aria-label="Consistency checks">{checks.checks.map(check => <li key={check.id}><span className={check.status === "pass" ? styles.badge : styles.warningBadge}>{check.status === "pass" ? "Passed" : check.status === "warning" ? "Review" : "Unavailable"}</span><span>{check.message}</span></li>)}</ul>}
          {exactSaved && selection?.consistency.status === "warning" && <label className={styles.review}><input type="checkbox" checked={controller.reviewedWarnings} disabled={controller.loading || !!controller.pendingRequestKey || controller.pendingGeneration} onChange={event => controller.reviewWarnings(event.target.checked)} />I reviewed the warnings for this saved mix.</label>}
          {!controller.canSave && !controller.pendingRequestKey && <p className={styles.caption}>Saving needs an available owned workspace and current saved inputs. Your preview stays here.</p>}
          <div className={styles.actions}><button type="button" disabled={!controller.canSave || controller.loading || !controller.draft || checks?.status === "blocked" || stale || exactSaved} onClick={() => { void controller.saveMix(); }}>Save mix</button>
            <button type="button" disabled={!controller.canSave || controller.loading || !exactSaved || stale || selection?.consistency.status === "blocked" || selection?.consistency.status === "warning" && !controller.reviewedWarnings || !!overview.approval} onClick={() => { void controller.approve(); }}>Approve identity</button></div>
          <p className={styles.caption}>Saving keeps this mix. Approval is a separate step before refreshed brand files.</p>
          <details className={styles.details}><summary>Fonts and usage permissions</summary><FontPicker typography={choices ? overview.typography.find(t => t.id === choices.typographyVersionId) ?? null : null} fonts={overview.fonts} showActions /></details>
        </section>}
        {(controller.hasDirectionDraft || controller.pendingRequestKey || stale) && <details className={styles.details}><summary>Reload options</summary>
          <p className={styles.caption}>Discarding removes only your unsaved mix. Saved requests and other brief or logo edits are retained.</p>
          {!controller.canDiscardDraft && <p className={styles.caption}>Check or resolve the retained request and other logo edits before discarding this local mix.</p>}
          <button type="button" disabled={controller.loading || !controller.canDiscardDraft} onClick={() => { if (window.confirm("Discard only this unsaved mix and reload saved work? Saved requests and other brief or logo edits will be kept.")) void controller.discardAndReload(); }}>Discard mix draft and reload</button>
        </details>}
        {controller.requestStatus && <p className={styles.notice} role="status">{controller.requestStatus}</p>}
      </>}
    {controller.canRead && controller.pendingRequestKey && <div className={styles.notice}><strong>A previous request needs checking</strong>
      <p>Your exact original request is retained. Checking never sends it again. Retry checks first, then may resend the same request with its original choices.</p>
      <div className={styles.actions}><button type="button" disabled={controller.loading} onClick={() => { void controller.reconcile(); }}>Check saved request</button>
        <button type="button" disabled={controller.loading || !controller.canRetryRequest} onClick={() => { void controller.retryOriginal(); }}>Retry original {controller.pendingRequestKind === "approval" ? "approval" : "save"}</button></div>
    </div>}
  </section>;
}
