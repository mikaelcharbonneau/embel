import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { EnrollmentBindingPublisher,EnrollmentContext,EnrollmentHttpBinding,EnrollmentPublication,EnrollmentRevocationProof } from "../../src/server/account-enrollment/contracts";
import { EnrollmentEffectUnavailable } from "../../src/server/account-enrollment/contracts";
import { createEnrollmentVaultClient } from "./vault-client";
import { restrictedOwnerPoolOptions } from "./process-qualification";

const ref=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u);
const capability=z.enum(["home_attachments","identity_transactions"]);
const bindingSchema=z.strictObject({managementVersion:z.literal(2),ownerId:z.uuid(),generation:z.number().int().positive(),revision:z.number().int().positive(),capability,operationKey:z.uuid(),
 roleName:z.string().max(63),roleOid:z.number().int().positive(),managerRoleName:z.literal("embel_account_role_manager"),managerRoleOid:z.number().int().positive(),credentialRef:ref});
const recordSchema=z.strictObject({version:z.literal(1),state:z.enum(["published","withdrawn"]),binding:bindingSchema,receipt:ref});
const absenceSchema=z.strictObject({version:z.literal(1),state:z.literal("withdrawn_absent"),ownerId:z.uuid(),generation:z.number().int().positive(),revision:z.number().int().positive(),
 capability,operationKey:z.uuid(),receipt:ref});
const pointerSchema=z.union([recordSchema,absenceSchema]);
const unavailable=(uncertain=false)=>new EnrollmentEffectUnavailable("publication_unavailable",uncertain);
function prefix(value:string){if(!/^[A-Za-z0-9][A-Za-z0-9_/-]{0,39}$/u.test(value)||value.split("/").some(p=>!p||p==="."||p===".."))throw unavailable();return value;}
function newer(a:{generation:number;revision:number},b:{generation:number;revision:number}){return a.generation>b.generation||a.generation===b.generation&&a.revision>b.revision;}
function expectedRole(binding:EnrollmentHttpBinding){return`${binding.capability==="home_attachments"?"embel_home_web_":"embel_identity_web_"}${binding.ownerId.replaceAll("-","")}`;}
function publication(binding:EnrollmentHttpBinding,state:"published"|"withdrawn"):EnrollmentPublication{
 return{ownerId:binding.ownerId,generation:binding.generation,revision:binding.revision,operationKey:binding.operationKey,capability:binding.capability,
  receipt:`http-binding:${createHash("sha256").update(JSON.stringify({state,binding})).digest("hex")}`};
}
function bound(context:EnrollmentContext,binding:EnrollmentHttpBinding){
 if(context.claim.ownerId!==binding.ownerId||context.claim.generation!==binding.generation||context.claim.revision!==binding.revision||context.step.operationKey!==binding.operationKey
  ||context.step.capability!==binding.capability||binding.roleName!==expectedRole(binding)||context.step.credentialRef!==binding.credentialRef)throw unavailable();
}
/** Operator-side immutable-reference publication with CAS monotonic owner
 * pointers. Only public role/binding references enter these records. */
export function createVaultHttpBindingPublisher(configuration:{vault:unknown;publicationPrefix:string;
 credentials?:Pick<ReturnType<typeof import("./vault-credentials").createVaultEnrollmentCredentialStore>,"drainConnections">}):EnrollmentBindingPublisher{
 const client=createEnrollmentVaultClient(configuration.vault),root=prefix(configuration.publicationPrefix);
 const key=(ownerId:string,cap:string)=>`${root}/${z.uuid().parse(ownerId)}/${capability.parse(cap)}`;
 return{
  async publish(context,input,signal){
   const binding=bindingSchema.parse(input);bound(context,binding);if(context.claim.mode!=="enroll")throw unavailable();const pub=publication(binding,"published");
   for(let attempt=0;attempt<3;attempt++){
    const prior=await client.read(key(binding.ownerId,binding.capability),signal);
    if(prior){const record=pointerSchema.parse(prior.data),scope=record.state==="withdrawn_absent"?record:record.binding;
     if(scope.ownerId!==binding.ownerId||scope.capability!==binding.capability||newer(scope,binding))throw unavailable(true);
     if(scope.generation===binding.generation&&scope.revision===binding.revision){if(record.state!=="published"||JSON.stringify(record.binding)!==JSON.stringify(binding)||record.receipt!==pub.receipt)throw unavailable(true);return pub;}}
    if(await client.write(key(binding.ownerId,binding.capability),prior?.version??0,{version:1,state:"published",binding,receipt:pub.receipt},signal)!==null)return pub;
   }throw unavailable(true);
  },
  async verify(context,input,pub,signal){
   const binding=bindingSchema.parse(input);bound(context,binding);const value=await client.read(key(binding.ownerId,binding.capability),signal),record=recordSchema.parse(value?.data);
   if(record.state!=="published"||JSON.stringify(record.binding)!==JSON.stringify(binding)||record.receipt!==pub.receipt||JSON.stringify(publication(binding,"published"))!==JSON.stringify(pub))throw unavailable(true);return pub;
  },
  async revoke(context,signal):Promise<EnrollmentRevocationProof>{
   if(context.claim.mode!=="revoke")throw unavailable();const pointer=key(context.claim.ownerId,context.step.capability);
   async function prove(receipt:string){
    const result=await context.store.operator.query("SELECT public.verify_account_http_revocation($1,$2,$3,$4) value",[context.claim.id,context.claim.leaseToken,context.step.capability,receipt]);
    if(result.rows.length!==1)throw unavailable(true);const proof=(result.rows[0] as{value:EnrollmentRevocationProof}).value,observed=Date.parse(proof?.observedAt);
    if(!proof||proof.ownerId!==context.claim.ownerId||proof.generation!==context.claim.generation||proof.revision!==context.claim.revision||proof.operationKey!==context.step.operationKey
     ||proof.capability!==context.step.capability||proof.authorityDisabled!==true||!("runtimeStopped" in proof)||proof.runtimeStopped!==true||proof.storageDenied!==true||!Number.isFinite(observed)||Date.now()-observed>30_000||observed>Date.now())throw unavailable(true);return proof;
   }
   for(let attempt=0;attempt<3;attempt++){
    const current=await client.read(pointer,signal),prior=current?pointerSchema.parse(current.data):null;
    if(!prior||prior.state==="withdrawn_absent"){
     if(prior&&(prior.ownerId!==context.claim.ownerId||prior.capability!==context.step.capability||newer(prior,context.claim)))throw unavailable(true);
     const scope={ownerId:context.claim.ownerId,generation:context.claim.generation,revision:context.claim.revision,capability:capability.parse(context.step.capability),operationKey:context.step.operationKey};
     const tombstone={version:1 as const,state:"withdrawn_absent" as const,...scope,receipt:`http-absent:${createHash("sha256").update(JSON.stringify(scope)).digest("hex")}`};
     if(JSON.stringify(prior)!==JSON.stringify(tombstone)&&await client.write(pointer,current?.version??0,tombstone,signal)===null)continue;
     const observed=absenceSchema.parse((await client.read(pointer,signal))?.data);if(JSON.stringify(observed)!==JSON.stringify(absenceSchema.parse(tombstone)))throw unavailable(true);
     return prove(observed.receipt);
    }
    if(!current)throw unavailable(true);const record=prior,b=record.binding;
    if(b.ownerId!==context.claim.ownerId||b.capability!==context.step.capability||newer(b,context.claim))throw unavailable(true);
    if(record.state!=="withdrawn"&&await client.write(pointer,current.version,{...record,state:"withdrawn",receipt:publication(b,"withdrawn").receipt},signal)===null)continue;
    const check=recordSchema.parse((await client.read(pointer,signal))?.data);if(check.state!=="withdrawn"||JSON.stringify(check.binding)!==JSON.stringify(b))throw unavailable(true);
    await configuration.credentials?.drainConnections(b.credentialRef);
    // SQL must independently qualify the locked actual role and installed
    // managed Home Storage denial contract. Pointer withdrawal alone is never
    // promoted to authorityDisabled/storageDenied or a revocation witness.
    return prove(check.receipt);
   }throw unavailable(true);
  },
 };
}
type Configuration=Omit<EnrollmentHttpBinding,"ownerId"|"credentialRef">&{databaseUrl:string};
export type AccountHttpPublishedRecord={ownerId:string;generation:number;revision:number;identity?:{publicationReceipt:string;configuration:Configuration};attachments?:{publicationReceipt:string;configuration:Configuration}};
/** Read-only web-side source. Supply a separate read-only token restricted to
 * HTTP publication/credential paths. Never supply the operator, worker, provider
 * or launcher token. The caller must compare Auth's owner-derived current SQL
 * generation/revision/operation/publication receipt BEFORE opening any pool. */
export function createVaultAccountHttpBindingSource(configuration:{vault:unknown;publicationPrefix:string;credentialPrefix:string}){
 const client=createEnrollmentVaultClient(configuration.vault),root=prefix(configuration.publicationPrefix),credentials=prefix(configuration.credentialPrefix);
 return{async read(ownerId:string,signal?:AbortSignal):Promise<AccountHttpPublishedRecord|null>{
  const owner=z.uuid().parse(ownerId).toLowerCase();
  const values=await Promise.all(["home_attachments","identity_transactions"].map(async cap=>{
   const result=await client.read(`${root}/${owner}/${cap}`,signal);if(!result)return null;const record=pointerSchema.parse(result.data),scope=record.state==="withdrawn_absent"?record:record.binding;
   if(scope.ownerId!==owner||scope.capability!==cap||record.state!=="withdrawn_absent"&&record.binding.roleName!==expectedRole(record.binding))throw unavailable();return record;
  }));
  const latest=values.filter(v=>v!==null).map(v=>v.state==="withdrawn_absent"?v:v.binding).sort((a,b)=>a.generation-b.generation||a.revision-b.revision).at(-1);if(!latest)return null;
  const result:AccountHttpPublishedRecord={ownerId:owner,generation:latest.generation,revision:latest.revision};
  for(const record of values){if(!record||record.state!=="published"||record.binding.generation!==latest.generation||record.binding.revision!==latest.revision)continue;
   const b=record.binding,expectedRef=`${credentials}/${owner}/${b.generation}/${b.capability}/${b.operationKey}`;
   if(b.credentialRef!==expectedRef||record.receipt!==publication(b,"published").receipt)throw unavailable();
   const stored=await client.read(expectedRef,signal);const secret=z.object({version:z.literal(1),ownerId:z.literal(owner),generation:z.literal(b.generation),revision:z.literal(b.revision),operationKey:z.literal(b.operationKey),
    capability:z.literal(b.capability),retired:z.literal(false),secrets:z.object({database:z.strictObject({databaseUrl:z.string(),caPem:z.string()})})}).parse(stored?.data);
   restrictedOwnerPoolOptions(b.roleName,secret.secrets.database,"embel-http-binding-reader");
   const {ownerId:_owner,credentialRef:_ref,...metadata}=b;void _owner;void _ref;
   result[b.capability==="home_attachments"?"attachments":"identity"]={publicationReceipt:record.receipt,configuration:{...metadata,databaseUrl:secret.secrets.database.databaseUrl}};
  }
  return result.identity||result.attachments?result:null;
 }};
}
