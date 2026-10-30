"use client";
import { ContextDetails } from "@/components/ui/context-details";
import { useEffect, useEffectEvent, useId, useState } from "react";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import { privatePreviewIdentity } from "@/components/assets/private-preview-identity";
import type { LogoVariant, LogoVariantSet } from "@/domain/logo-deliverables";
import styles from "./deliverables.module.css";

function previewIdentity(variant: LogoVariant): string | null {
 const receipt=variant.preview;
 return receipt?privatePreviewIdentity(receipt.reference,[receipt.id,receipt.publicationState,receipt.purpose,receipt.sourceReceiptId,
  receipt.rightsEvidenceId,receipt.verification.status,receipt.verification.contentHash,receipt.verification.mimeType,receipt.verification.byteLength]):null;
}
function VariantCard({variant,client,disabled,checked,onReview}:{variant:LogoVariant;client:AccountLogoClient;disabled:boolean;checked:boolean;onReview(id:string,accepted:boolean):void}) {
 const [attempt,setAttempt]=useState(0);
 const [preview,setPreview]=useState<{client:AccountLogoClient;key:string;attempt:number;url:string|null;status:"loading"|"ready"|"unavailable"}|null>(null),[background,setBackground]=useState<"light"|"dark"|"checker">(variant.colorway==="white"?"dark":"checker");
 const key=previewIdentity(variant),readReceipt=useEffectEvent(()=>variant.preview);
 // Parsed polling receipts are replaceable; immutable byte/eligibility evidence is not.
 // Clear released state on a real transition so A/B/A cannot resurrect an old URL.
 if(preview&&(preview.client!==client||preview.key!==key||preview.attempt!==attempt))setPreview(null);
 useEffect(()=>{
  const receipt=readReceipt();if(!receipt||!key)return;
  const abort=new AbortController();let release:(()=>void)|undefined;
  void client.previewAsset(receipt,abort.signal).then(result=>{
   if(abort.signal.aborted){result?.release();return;}
   release=result?.release;setPreview({client,key,attempt,url:result?.url??null,status:result?"loading":"unavailable"});
  }).catch(()=>{if(!abort.signal.aborted)setPreview({client,key,attempt,url:null,status:"unavailable"});});
  return()=>{abort.abort();release?.();};
 },[client,key,attempt]);
 const current=preview?.client===client&&preview.key===key&&preview.attempt===attempt?preview:null;
 const ready=current?.status==="ready",unavailable=!key||current?.status==="unavailable";
 return <article className={styles.variant}>
  <h4>{variant.role.replaceAll("_"," ")} · {variant.colorway}</h4>
  <div className={`${styles.preview} ${styles[background]}`}>
   {/* Private bytes are verified by AccountLogoClient; the object URL is released on unmount. */}
   {/* eslint-disable-next-line @next/next/no-img-element */}
   {current?.url&&!unavailable?<img src={current.url} alt={`${variant.role.replaceAll("_"," ")} logo, ${variant.colorway}`} onLoad={()=>setPreview(value=>value===current?{...value,status:"ready"}:value)} onError={()=>{setPreview(value=>value===current?{...value,status:"unavailable"}:value);onReview(variant.id,false);}}/>:<p role="status">{unavailable?"Preview unavailable. Your saved variant is kept.":"Loading logo preview…"}</p>}
  </div>
  {key&&unavailable&&<button type="button" onClick={()=>{onReview(variant.id,false);setAttempt(value=>value+1);}}>Retry preview</button>}
  <div className={styles.backgrounds} aria-label="Preview background">{(["light","dark","checker"] as const).map(value=><button type="button" key={value} aria-pressed={background===value} onClick={()=>setBackground(value)}>{value}</button>)}</div>
  <p className={styles.caption}>Clear space: {variant.clearSpace.toFixed(1)} units. {variant.minimumDigitalSize===null?"Minimum digital size is not assigned.":`Minimum size: ${variant.minimumDigitalSize} px.`}</p>
  <label className={styles.check}><input type="checkbox" checked={checked&&ready} disabled={disabled||!ready} onChange={event=>onReview(variant.id,event.target.checked)}/>I checked spelling, edges and spacing.</label>
 </article>;
}
export function VariantReview({set,client,disabled,reviewed,onSubmit}:{set:LogoVariantSet;client:AccountLogoClient;disabled:boolean;reviewed:boolean;onSubmit(ids:readonly string[]):void}) {
 const id=useId(),required=set.items.filter(item=>item.applicability.status==="applicable");
 // Review acceptance belongs to this exact set and preview evidence, not its ID alone.
 const key=JSON.stringify([set.ownerId,set.projectId,set.id,set.approvedLogoId,set.directionApprovalId,required.map(variant=>[variant.id,variant.role,variant.colorway,variant.documentAsset,variant.renderHash,variant.clearSpace,variant.minimumDigitalSize,previewIdentity(variant)])]);
 const [selection,setSelection]=useState<{key:string;client:AccountLogoClient;ids:string[]}>({key,client,ids:[]});
 if(selection.key!==key||selection.client!==client)setSelection({key,client,ids:[]});
 const accepted=selection.key===key&&selection.client===client?selection.ids:[];
 return <section aria-labelledby={id} className={styles.review}><div className={styles.row}><h3 id={id}>Review logo variants</h3><span className={styles.badge}>{reviewed?"Saved visual review":"Review required"}</span></div>
  <p className={styles.caption}>Check each arrangement and color on light, dark and transparent backgrounds. The color version preserves your approved artwork.</p>
  <div className={styles.variants}>{required.map(variant=><VariantCard key={`${set.id}:${variant.id}`} variant={variant} client={client} disabled={disabled||reviewed} checked={accepted.includes(variant.id)} onReview={(variantId,value)=>setSelection(prior=>prior.key!==key||prior.client!==client?prior:{...prior,ids:value?[...new Set([...prior.ids,variantId])]:prior.ids.filter(item=>item!==variantId)})}/>)}</div>
  <ContextDetails className={styles.details} title={<>Arrangements that do not apply</>}><ul>{set.items.filter(item=>item.applicability.status==="not_applicable").map(item=><li key={item.id}>{item.role.replaceAll("_"," ")} · {item.colorway}: {item.applicability.status==="not_applicable"&&item.applicability.reason==="no_symbol"?"No separate symbol":"Artwork cannot be safely separated"}</li>)}</ul></ContextDetails>
  {!reviewed&&<button type="button" disabled={disabled||accepted.length!==required.length||!required.length} onClick={()=>onSubmit(accepted)}>Save visual review</button>}
 </section>;
}
