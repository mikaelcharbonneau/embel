"use client";
import { useEffect, useId, useState } from "react";
import type { AccountLogoClient } from "@/components/identity/account-logo-client";
import type { LogoVariant, LogoVariantSet } from "@/domain/logo-deliverables";
import styles from "./deliverables.module.css";
function VariantCard({variant,client,disabled,onReview}:{variant:LogoVariant;client:AccountLogoClient;disabled:boolean;onReview(id:string,accepted:boolean):void}) {
 const [preview,setPreview]=useState<{client:AccountLogoClient;version:string;url:string}|null>(null),[loaded,setLoaded]=useState<string|null>(null),[checked,setChecked]=useState(false),[background,setBackground]=useState<"light"|"dark"|"checker">(variant.colorway==="white"?"dark":"checker");
 const receipt=variant.preview,version=receipt?.reference.versionId??"";
 useEffect(()=>{if(!receipt)return;const abort=new AbortController();let release:(()=>void)|undefined;void client.previewAsset(receipt,abort.signal).then(result=>{if(!result)return;release=result.release;if(abort.signal.aborted){release();return;}setPreview({client,version,url:result.url});}).catch(()=>{});return()=>{abort.abort();release?.();};},[client,receipt,version]);
 const current=preview?.client===client&&preview.version===version?preview:null;
 const ready=!!current&&loaded===current.url;
 return <article className={styles.variant}>
  <h4>{variant.role.replaceAll("_"," ")} · {variant.colorway}</h4>
  <div className={`${styles.preview} ${styles[background]}`}>
   {/* Private bytes are verified by AccountLogoClient; the object URL is released on unmount. */}
   {/* eslint-disable-next-line @next/next/no-img-element */}
   {current?<img src={current.url} alt={`${variant.role.replaceAll("_"," ")} logo, ${variant.colorway}`} onLoad={()=>setLoaded(current.url)} onError={()=>{setLoaded(null);setChecked(false);onReview(variant.id,false);}}/>:<p>Verified preview unavailable</p>}
  </div>
  <div className={styles.backgrounds} aria-label="Preview background">{(["light","dark","checker"] as const).map(value=><button type="button" key={value} aria-pressed={background===value} onClick={()=>setBackground(value)}>{value}</button>)}</div>
  <p className={styles.caption}>Clear space: {variant.clearSpace.toFixed(1)} units. {variant.minimumDigitalSize===null?"Minimum digital size is not assigned.":`Minimum size: ${variant.minimumDigitalSize} px.`}</p>
  <label className={styles.check}><input type="checkbox" checked={checked&&ready} disabled={disabled||!ready} onChange={event=>{setChecked(event.target.checked);onReview(variant.id,event.target.checked);}}/>I checked spelling, edges and spacing.</label>
 </article>;
}
export function VariantReview({set,client,disabled,reviewed,onSubmit}:{set:LogoVariantSet;client:AccountLogoClient;disabled:boolean;reviewed:boolean;onSubmit(ids:readonly string[]):void}) {
 const id=useId(),[selection,setSelection]=useState<{setId:string;ids:string[]}>({setId:set.id,ids:[]});
 const accepted=selection.setId===set.id?selection.ids:[],required=set.items.filter(item=>item.applicability.status==="applicable");
 return <section aria-labelledby={id} className={styles.review}><div className={styles.row}><h3 id={id}>Review logo variants</h3><span className={styles.badge}>{reviewed?"Saved visual review":"Review required"}</span></div>
  <p className={styles.caption}>Check each arrangement and color on light, dark and transparent backgrounds. The color version preserves your approved artwork.</p>
  <div className={styles.variants}>{required.map(variant=><VariantCard key={`${set.id}:${variant.id}`} variant={variant} client={client} disabled={disabled||reviewed} onReview={(variantId,value)=>setSelection(prior=>({setId:set.id,ids:value?[...new Set([...(prior.setId===set.id?prior.ids:[]),variantId])]:(prior.setId===set.id?prior.ids:[]).filter(item=>item!==variantId)}))}/>)}</div>
  <details className={styles.details}><summary>Arrangements that do not apply</summary><ul>{set.items.filter(item=>item.applicability.status==="not_applicable").map(item=><li key={item.id}>{item.role.replaceAll("_"," ")} · {item.colorway}: {item.applicability.status==="not_applicable"&&item.applicability.reason==="no_symbol"?"No separate symbol":"Artwork cannot be safely separated"}</li>)}</ul></details>
  {!reviewed&&<button type="button" disabled={disabled||accepted.length!==required.length||!required.length} onClick={()=>onSubmit(accepted)}>Save visual review</button>}
 </section>;
}
