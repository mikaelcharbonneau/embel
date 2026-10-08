import type { LogoManualEdit, LogoVectorDocument } from "../../../domain/logo-vector";
import type { LogoHistoryPage } from "../../../domain/logo-workspace";
import { validateLogoVectorDocument } from "../model/geometry";
import { ComponentControls } from "./component-controls";
import { ConversionReviewPresentation } from "./conversion-review";
import { LogoHistoryPresentation } from "./logo-history";
import styles from "./logo-vector.module.css";

export type LogoEditorPresentationMode = "unavailable" | "review_required" | "stale" | "conflict" | "read_only";
type Props = {
  document: LogoVectorDocument | null;
  mode: LogoEditorPresentationMode;
  selectedComponentId: string | null;
  lockedComponentIds: readonly string[];
  onSelectComponent: (componentId: string) => void;
  onEdit: (edit: LogoManualEdit) => void;
  history: LogoHistoryPage | null;
};
const notices: Record<LogoEditorPresentationMode, { title: string; message: string }> = {
  unavailable: { title: "Vector editing unavailable", message: "A verified canonical vector document is needed to begin editing." },
  review_required: { title: "Review required", message: "Compare the original with the candidate before accepting a vector. This preview has not been accepted." },
  stale: { title: "Earlier input version", message: "This preview uses earlier inputs. Review the changed basis before accepting or refreshing downstream files." },
  conflict: { title: "Revision conflict", message: "Your local preview is retained. Review the latest saved version before choosing how to continue." },
  read_only: { title: "Read-only preview", message: "This document can be inspected. Editing is currently unavailable." },
};

/** Unmounted domain-valued view; not the planned LogoEditor({workspace, client}) account wrapper. */
export function LogoEditorPresentation({ document, mode, selectedComponentId, lockedComponentIds, onSelectComponent, onEdit, history }: Props) {
  let validated: LogoVectorDocument | null = null;
  let invalid = false;
  if (document !== null && mode !== "unavailable") {
    try { validated = validateLogoVectorDocument(document); } catch { invalid = true; }
  }
  const notice = notices[mode];
  const disabledReason = mode === "read_only" ? "Read-only preview: edits are unavailable." : mode === "conflict" ? "Resolve the revision conflict before editing." : undefined;
  return <section className={styles.editor} aria-label="Logo vector editor">
    <header className={styles.editorHeader}><div><p className={styles.eyebrow}>Logo · Vector</p><h2>Refine your logo</h2></div><span className={styles.badge}>Local preview — unsaved</span></header>
    <div className={styles.notice} role={mode === "conflict" ? "alert" : "status"}><strong>{notice.title}</strong><p>{notice.message}</p></div>
    {invalid && <p className={styles.notice} role="alert">Vector preview unavailable: the document failed geometry validation.</p>}
    {validated && <>
      <ConversionReviewPresentation document={validated} />
      <div className={styles.editLayout}>
        <nav className={styles.componentList} aria-label="Logo components"><h3>Components</h3>
          {validated.components.map(component => <button key={component.id} type="button" aria-pressed={selectedComponentId === component.id} onClick={() => onSelectComponent(component.id)}>
            <span>{component.role.replaceAll("_", " ")}</span><small>{component.editingKind === "outlined_custom" ? "Outlined lettering" : component.editingKind === "editable_text" ? "Text outlines" : "Vector geometry"}{lockedComponentIds.includes(component.id) ? " · Local lock" : ""}</small>
          </button>)}
        </nav>
        <ComponentControls document={validated} componentId={selectedComponentId ?? ""} lockedComponentIds={lockedComponentIds} onEdit={onEdit} disabledReason={disabledReason} />
      </div>
    </>}
    <div className={styles.actions} aria-label="Vector actions">
      <button type="button" disabled>Save edit</button><button type="button" disabled>Accept this vector</button><button type="button" disabled>Export logo</button>
    </div>
    <p className={styles.caption}>Saving is unavailable until account validation and immutable revision storage are connected. Local lock choices are preview controls; they are not saved protection.</p>
    <div className={styles.actions} aria-label="Conversion and refinement actions">
      <button type="button" disabled>Retry conversion</button><button type="button" disabled>Simplify conversion</button><button type="button" disabled>Refine with AI</button>
    </div>
    <p className={styles.caption}>Conversion and AI refinement are unavailable. Refinement needs a real provider, a cost estimate and an explicit request. Raster refinement cannot preserve locked components.</p>
    <LogoHistoryPresentation history={history} />
  </section>;
}
