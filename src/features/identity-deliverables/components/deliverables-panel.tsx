"use client";
import { useId } from "react";
import { useProjectIdentityEvidence } from "@/components/workspace/project-workspace";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import type { LogoWorkspaceV2 } from "@/domain/logo-workspace";
import { OutputPrerequisites } from "@/components/identity/output-prerequisites";
import { VariantReview } from "./variant-review";
import { useLogoExports, type LogoExportsController } from "./use-logo-exports";
import styles from "./deliverables.module.css";
export function DeliverablesPanel({workspace,client}:{workspace:LogoWorkspaceV2;client:AccountLogoClient}):React.JSX.Element {return <DeliverablesView controller={useLogoExports(client,workspace)} client={client}/>;}
export function DeliverablesView({controller:c,client}:{controller:LogoExportsController;client:AccountLogoClient}):React.JSX.Element {
 const title=useId(),variantTitle=useId(),overview=c.overview,set=overview?.variantSets.find(item=>item.id===c.variantSetId),reviewed=!!overview?.variantReviews.some(item=>item.variantSetId===set?.id);
 const currentVariantSource=!!set&&set.approvedLogoId===overview?.logoApproval?.id&&set.directionApprovalId===overview?.directionApproval?.id;
 useProjectIdentityEvidence(c.workspace ? { ownerId: c.workspace.ownerId, projectId: c.workspace.projectId, projectRevision: c.workspace.heads.projectRevision, approved: Boolean(!c.loading && !c.error && overview?.directionApproval && overview.logoApproval?.id === c.workspace.approvedLogo?.id && overview.directionApproval.approvedLogoId === c.workspace.approvedLogo?.id && !c.workspace.staleStages.some(stage => stage.stage === "directions")) } : null);
 const options=c.selectedOptions,locked=c.loading||!!c.pendingRequestKey;
 const social=(kind:"avatar"|"banner",selected:boolean)=>c.selectOptions({...options,socialSelections:[...options.socialSelections.filter(item=>item.kind!==kind),...(selected?[{kind,presetId:kind==="avatar"?"avatar-1024-contain-v1":"banner-1500x500-contain-v1"}]:[])]});
 return <section className={styles.panel} aria-labelledby={title} aria-busy={c.loading}>
  <header className={styles.header}><div><p className={styles.eyebrow}>Final deliverables</p><h2 id={title} className="project-output-inner-heading">Brand files</h2><p className={styles.caption}>Verified files from your approved logo and identity.</p></div><span className={styles.badge}>No AI generation</span></header>
  {!c.canRead?<p className={styles.notice} role="status">Sign in to the matching account to view saved brand files.</p>:<>
   <FilePrerequisites controller={c} currentVariants={currentVariantSource} reviewed={reviewed} variantHref={`#${variantTitle}`} />
   <div className={styles.row}><p className={styles.caption}>Existing files retain their original approved version.</p><button type="button" disabled={c.loading} onClick={()=>void c.refresh()}>Refresh saved work</button></div>
   {c.error&&<p className={styles.notice} role="alert">{c.error}</p>}
   <details className={styles.preparation} open={Boolean(overview?.logoApproval && overview.directionApproval)}>
   <summary>{overview?.logoApproval && overview.directionApproval ? "Prepare variants and export options" : "Preview formats and export options"}</summary>
   <div className={styles.preparationContent}>
   <div className={styles.requirements}><p>SVG, vector PDF and transparent PNG</p><p>Brand guidelines PDF included by default</p><p className={styles.caption}>Black, white and approved color versions, with applicable arrangements. Font binaries are not included.</p></div>
   <div id={variantTitle} className={styles.variantPreparation}>
   {(!set||!currentVariantSource)&&<div className={styles.empty}><h3>{set?"Prepare replacement variants":"Prepare logo variants"}</h3><p>{set?"Your logo or identity approval changed. Earlier variants remain in history; prepare a new set for these approvals.":"Review actual previews before requesting final files."}</p><button type="button" disabled={!c.canPrepare||locked} onClick={()=>void c.prepareVariants()}>{set?"Prepare replacement variants":"Prepare variants"}</button></div>}
   {set&&<VariantReview key={set.id} set={set} client={client} disabled={locked||!c.canPrepare||!currentVariantSource} reviewed={reviewed} onSubmit={ids=>void c.reviewVariants(ids)}/>}
   </div>
   <div className="project-export-layout"><section className="project-export-options"><h3>Export options</h3><div className={styles.options}><label>Transparent PNG long edge<select value={options.pngLongEdge} disabled={locked} onChange={event=>c.selectOptions({...options,pngLongEdge:Number(event.target.value) as 512|1024|2048|4096})}>{[512,1024,2048,4096].map(value=><option key={value} value={value}>{value.toLocaleString()} px</option>)}</select></label>
    <fieldset disabled={locked}><legend>Optional social files</legend><label className={styles.check}><input type="checkbox" checked={options.socialSelections.some(item=>item.kind==="avatar")} onChange={event=>social("avatar",event.target.checked)}/>Avatar · 1024 × 1024</label><label className={styles.check}><input type="checkbox" checked={options.socialSelections.some(item=>item.kind==="banner")} onChange={event=>social("banner",event.target.checked)}/>Banner · 1500 × 500</label><p className={styles.caption}>Generic containment sizes preserve the full logo and clear space.</p></fieldset>
   </div></section><section className="project-export-package"><h3>Your package</h3><p>SVG, vector PDF and transparent PNG</p><p>Colour palette and typography in your guidelines</p><p>{options.socialSelections.length} optional social {options.socialSelections.length === 1 ? "file" : "files"}</p>
   {c.blockedReason&&<p className={styles.notice} role="status">{c.blockedReason}</p>}
   <button type="button" className={styles.primary} disabled={!c.canExport||locked} onClick={()=>void c.request()}>Create brand files</button>
   </section></div>
   </div></details>
   {c.pendingRequestKey&&<div className={styles.notice}><strong>Your original request is retained</strong><p>Checking its status does not create another export or change its options.</p><div className={styles.actions}><button type="button" disabled={c.loading} onClick={()=>void c.reconcile()}>Check original export</button><button type="button" disabled={c.loading} onClick={()=>void c.retryOriginalExport()}>Retry original export</button></div></div>}
   {c.requestState&&c.requestState.status!=="not_found"&&<p className={styles.notice} role="status">Export status: {c.requestState.status.replaceAll("_"," ")}{c.requestState.reason?` · ${c.requestState.reason.replaceAll("_"," ")}`:""}</p>}
   {!!overview?.exportRequests.length&&<section className={styles.history} aria-label="Export requests"><h3>Export requests</h3>{overview.exportRequests.map(request=><article key={request.requestKey}><div className={styles.row}><div><strong>{request.state.status.replaceAll("_"," ")}</strong><p className={styles.caption}>{request.input.pngLongEdge} px PNG · {request.input.socialSelections.length?request.input.socialSelections.map(item=>item.kind).join(", "):"No social files"}</p></div><button type="button" disabled={c.loading} onClick={()=>void c.checkRequest(request.requestKey)}>Check status</button></div>{!request.exportManifestId&&request.state.outputs.length>0&&<><p className={styles.warning}>The pack is incomplete. Earlier verified individual files are retained.</p><ul className={styles.files}>{request.state.outputs.map((file,index)=><li key={file.id}><span>Verified {file.verification.mimeType.split("/")[1]} {index+1}</span><button type="button" disabled={c.loading} onClick={()=>void c.download(file)}>Check and download</button></li>)}</ul></>}</article>)}</section>}
   {!!overview?.exports.length&&<section className={styles.history} aria-label="Saved brand files"><h3>Saved brand files</h3>{overview.exports.map(({manifest,stale})=><details key={manifest.id} className={styles.details}><summary>{stale?"Earlier approved version":"Current approved version"} · {manifest.files.length} files</summary>{stale&&<p className={styles.warning}>These files use earlier choices. They remain available unchanged.</p>}<ul className={styles.files}>{manifest.files.map(file=><li key={file.asset.id}><span>{file.role.replaceAll("_"," ")} · {file.format.toUpperCase()}</span><button type="button" disabled={c.loading} onClick={()=>void c.download(file.asset)}>Check and download</button></li>)}</ul></details>)}</section>}
   {!overview&&c.loading&&<p className={styles.notice} role="status">Loading saved work. Export history has not been confirmed yet.</p>}
   {overview && !overview.exports.length && <section className="project-export-empty"><h3>Saved exports</h3><p>{c.loading?"No completed exports at the last check. Work is in progress.":c.error?"No completed exports at the last check. Refresh saved work to check the latest history.":"No completed exports yet."} Earlier requests and partial files remain available above.</p></section>}
   {(overview?.nextCursor||overview?.nextRequestCursor)&&<button type="button" disabled={c.loading} onClick={()=>void c.loadMore()}>Load earlier exports</button>}
   {c.downloadMessage&&<p className={styles.notice} role="status">{c.downloadMessage}</p>}
   <p className={styles.caption}>An export does not establish exclusive rights, copyright protection, uniqueness or trademark clearance. RGB logo PDFs carry no print-profile or PDF/X guarantee.</p>
  </>}
 </section>;
}

function FilePrerequisites({ controller: c, currentVariants, reviewed, variantHref }: { controller: LogoExportsController; currentVariants: boolean; reviewed: boolean; variantHref: string }) {
  const overview = c.overview, projectId = c.workspace?.projectId ?? overview?.projectId;
  const staleLogo = !!c.workspace?.staleStages.some(stage => stage.stage === "vector");
  const staleIdentity = !!c.workspace?.staleStages.some(stage => stage.stage === "directions");
  const changedLogo = !!(overview?.logoApproval && c.workspace && overview.logoApproval.id !== c.workspace.approvedLogo?.id);
  const logoApproved = !!overview?.logoApproval && !staleLogo && !changedLogo;
  const identityApproved = logoApproved && !!overview?.directionApproval && overview.directionApproval.approvedLogoId === overview.logoApproval?.id && !staleIdentity;
  const variantsCurrent = identityApproved && currentVariants;
  const ready = c.canExport && !c.loading && !c.error && !c.pendingRequestKey;
  const rechecking = !!overview && (c.loading || !!c.error);
  const checkedStatus = (status: string) => rechecking ? `${status} at last check` : status;
  let heading = "Check brand file preparation";
  let description = c.blockedReason ?? "Review the current logo variants before creating files. Existing files keep their original approved version.";
  let action: { href: string; label: string } | undefined;
  if (!overview) {
    heading = "Check your brand file prerequisites";
    description = c.loading ? "Checking saved approvals and export history. Their status has not been confirmed yet." : "Saved approval status has not been confirmed. Refresh saved work to check it.";
  } else if (!logoApproved) {
    heading = overview.logoApproval ? "Review your changed logo" : "Start with an approved logo";
    description = overview.logoApproval ? "Your logo approval or its inputs changed. Review the vector logo before preparing files for the current brand." : "A selected image preview is separate from approval. Review and approve the vector logo before preparing brand files.";
    if (projectId) action = { href: `/brands/account/${projectId}/logo/vector`, label: "Review vector logo" };
  } else if (!identityApproved) {
    heading = overview.directionApproval ? "Review your identity direction" : "Approve an identity direction";
    description = "Your vector logo is approved. Review and approve the matching identity direction before preparing brand files.";
    if (projectId) action = { href: `/brands/account/${projectId}/logo/directions`, label: "Review identity direction" };
  } else if (!variantsCurrent || !reviewed) {
    heading = variantsCurrent ? "Review logo variants" : "Prepare logo variants";
    action = { href: variantHref, label: heading };
  } else if (ready) {
    heading = "Ready to create brand files";
    description = "The current logo, identity and variant review are confirmed. Creating files is a separate action below.";
  }
  if (rechecking) {
    heading = "Check saved brand file approvals";
    description = c.loading ? "Checking saved work. The approval statuses below are from the last confirmed check." : "The latest check failed. The approval statuses below are from the last confirmed check. Refresh saved work before continuing.";
    action = undefined;
  }
  return <OutputPrerequisites heading={heading} description={description} action={action} steps={[
    { label: "Vector logo", status: !overview ? "Not confirmed" : checkedStatus(logoApproved ? "Approved" : overview.logoApproval ? "Review required" : "Not approved") },
    { label: "Identity direction", status: !overview ? "Not confirmed" : checkedStatus(identityApproved ? "Approved" : overview.directionApproval ? "Review required" : "Not approved") },
    { label: "Logo variants", status: !overview ? "Not confirmed" : checkedStatus(!variantsCurrent ? "Not prepared for current approvals" : reviewed ? "Reviewed" : "Review required") },
  ]} />;
}
