import { z } from 'zod';
import type { LogoInputClient } from '@/features/logo-inputs/client/controller';
import * as I from '@/features/logo-inputs/model/contracts';
import { canonicalIdentityInput } from '@/features/identity-directions/model/font-check-binding';
import { fontRecordSchema } from '@/domain/logo-directions';
import { logoUuidSchema } from '@/domain/logo-vector';
import { type AccountLogoClient, isAccountLogoClientCurrent } from './account-logo-client';
import type { VerifiedAccount } from '../workspace/account-session';
import { AccountRequestError } from '../workspace/account-api';
/** Adds bounded input HTTP transport to the existing account's verified preview
 * and reference readers without duplicating or weakening their ownership fence. */
export function createLogoInputHttpClient(base:AccountLogoClient,account:VerifiedAccount,projectId:string,isCurrent:(a:VerifiedAccount)=>boolean,expire:(a:VerifiedAccount)=>void,fetcher:typeof fetch=fetch):LogoInputClient {
  const project=logoUuidSchema.parse(projectId), captured=Object.freeze({...account});
  const current=()=>isCurrent(captured)&&isAccountLogoClientCurrent(base,captured,project);
  const owned=(row:{ownerId:string;projectId:string})=>row.ownerId===captured.userId&&row.projectId===project;
  function parse<T>(schema:z.ZodType<T>,value:unknown):T {const result=schema.safeParse(value);if(!result.success)throw new AccountRequestError(422);return result.data;}
  async function request<T>(suffix:string,schema:z.ZodType<T>,verify:(value:T)=>boolean,signal?:AbortSignal,body?:string|FormData):Promise<T|null>{
    if(!current()||signal?.aborted)return null;
    try {
      const response=await fetcher(`/api/projects/${project}/logo${suffix}`,{method:body===undefined?'GET':'POST',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',signal,headers:{Accept:'application/json',...(typeof body==='string'?{'Content-Type':'application/json'}:{})},...(body===undefined?{}:{body})});
      if(!current()||signal?.aborted)return null;
      if(response.status===401){base.dispose();expire(captured);return null;}
      if(!response.ok)throw new AccountRequestError(response.status);
      if(response.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json')throw new AccountRequestError(502);
      const max=4*1024*1024, advertised=response.headers.get('content-length');
      if(advertised!==null&&(!/^\d+$/.test(advertised)||Number(advertised)>max))throw new AccountRequestError(502);
      const reader=response.body?.getReader();if(!reader)throw new AccountRequestError(502);
      const bytes=new Uint8Array(max);let length=0;
      try {for(;;){const chunk=await reader.read();if(!current()||signal?.aborted)return null;if(chunk.done)break;if(length+chunk.value.byteLength>max)throw new AccountRequestError(502);bytes.set(chunk.value,length);length+=chunk.value.byteLength;}}
      finally{void reader.cancel().catch(()=>undefined);reader.releaseLock();}
      const parsed=schema.safeParse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length))));
      if(!parsed.success||!verify(parsed.data))throw new AccountRequestError(502);
      return current()&&!signal?.aborted?parsed.data:null;
    }catch(error){if(!current()||signal?.aborted)return null;throw error instanceof AccountRequestError?error:new AccountRequestError(502);}
  }
  return {
    listLogoReferences:base.listLogoReferences,listLogoFonts:base.listLogoFonts,previewLogoReference:base.previewLogoReference,
    async uploadLogoReference(input,signal){
      if(!current()||signal?.aborted)return null;
      if(!(input.file instanceof File)||input.file.size>I.LOGO_REFERENCE_UPLOAD_MAX_BYTES)throw new AccountRequestError(413);
      return base.uploadLogoReference(input,signal);
    },
    async listCatalogLogoFonts(signal){return request('/fonts/catalog',z.array(I.catalogLogoFontSchema).max(100),()=>true,signal);},
    async listLogoInputRequests(input={},signal){const query=parse(I.logoInputRequestQuerySchema,input),params=new URLSearchParams({limit:String(query.limit)});if(query.cursor)params.set('cursor',query.cursor);return request(`/inputs/requests?${params}`,I.logoInputRequestPageSchema,owned,signal);},
    async cancelLogoInputRequest(input,signal){
      if(!current()||signal?.aborted)return null;
      const original=parse(I.logoInputCancellationSchema,input),body=JSON.stringify(original);
      if(new TextEncoder().encode(body).byteLength>I.LOGO_INPUT_METADATA_MAX_BYTES+4096)throw new AccountRequestError(413);
      return request(`/inputs/requests/${original.input.requestKey}/cancel`,I.logoInputRequestStateSchema,value=>value.status!=='not_found'&&owned(value)&&value.requestKey===original.input.requestKey&&canonicalIdentityInput(value.request)===canonicalIdentityInput(original),signal,body);
    },
    async readLogoInputRequest(requestKey,signal){const key=parse(logoUuidSchema,requestKey);return request(`/inputs/requests/${key}`,I.logoInputRequestStateSchema,value=>value.status==='not_found'||owned(value)&&value.requestKey===key,signal);},
    async importCatalogLogoFont(input,signal){const body=parse(I.importCatalogLogoFontInputSchema,input);return request('/fonts/imports',fontRecordSchema,value=>owned(value.asset)&&value.source==='free_catalog',signal,JSON.stringify(body));},
    async uploadLogoFont(input,signal){
      if(!current()||signal?.aborted)return null;
      const {file,...metadata}=input,body=parse(I.uploadLogoFontInputSchema,metadata);
      if(!(file instanceof File)||file.size<12||file.size>I.LOGO_FONT_UPLOAD_MAX_BYTES||!['font/ttf','font/otf'].includes(file.type))throw new AccountRequestError(422);
      const text=JSON.stringify(body);if(new TextEncoder().encode(text).byteLength>I.LOGO_INPUT_METADATA_MAX_BYTES)throw new AccountRequestError(413);
      const form=new FormData();form.set('input',text);form.set('file',file);
      return request('/fonts/uploads',fontRecordSchema,value=>owned(value.asset)&&value.source==='user_upload',signal,form);
    },
  };
}
