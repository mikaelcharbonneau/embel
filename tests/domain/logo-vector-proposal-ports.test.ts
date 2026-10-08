import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {logoVectorProposalRetainedOutputSchema,logoVectorProposalObservedResultSchema,logoVectorProposalProviderResultSchema,logoVectorProposalStepOutputSchema} from '@/domain/logo-vector-proposal-evidence';
import {proposalObservation} from '../server/logo-vector-proposal-fixtures';
import {proposalId,proposed} from '../features/logo-vector/proposal-fixtures';
const bytes=Buffer.from([0,255,97,98,99]);
const retained=()=>({encoding:'base64',data:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,truncated:false});
it('retains even invalid UTF-8 and NUL bytes in JSONB-safe bounded base64',()=>{expect(logoVectorProposalRetainedOutputSchema.parse(retained())).toEqual(retained());});
it('rejects oversized, miscounted, noncanonical or falsely truncated output framing',()=>{
 for(const change of [{data:Buffer.alloc(32769).toString('base64'),byteLength:32769},{byteLength:4},{truncated:true},{data:'AB==',byteLength:1}])expect(logoVectorProposalRetainedOutputSchema.safeParse({...retained(),...change}).success).toBe(false);
 expect(logoVectorProposalRetainedOutputSchema.safeParse({...retained(),byteLength:100,truncated:true}).success).toBe(true);
});
it('only complete untruncated validated payloads have valid result status',()=>{
 const payload=proposed({kind:'size',componentId:'symbol',scale:2}),raw=Buffer.from(JSON.stringify(payload));
 const value={status:'valid',payload,reason:null,retainedOutput:{encoding:'base64',data:raw.toString('base64'),sha256:createHash('sha256').update(raw).digest('hex'),byteLength:raw.length,truncated:false}};
 expect(logoVectorProposalObservedResultSchema.safeParse(value).success).toBe(true);
 expect(logoVectorProposalObservedResultSchema.safeParse({...value,retainedOutput:{...retained(),byteLength:100,truncated:true}}).success).toBe(false);
 expect(logoVectorProposalProviderResultSchema.safeParse({kind:'observed',observation:{...proposalObservation(),responseComplete:false},result:value}).success).toBe(false);
 expect(logoVectorProposalProviderResultSchema.safeParse({kind:'observed',observation:proposalObservation(),result:value}).success).toBe(true);
});
it('keeps nondispatch distinct from observed and preserves invalid paid payload evidence',()=>{
 expect(logoVectorProposalProviderResultSchema.safeParse({kind:'not_dispatched',reason:'cancelled_before_dispatch'}).success).toBe(true);
 expect(logoVectorProposalObservedResultSchema.safeParse({status:'invalid',payload:null,reason:'invalid_output',retainedOutput:retained()}).success).toBe(true);
 expect(logoVectorProposalProviderResultSchema.safeParse({kind:'not_dispatched',reason:'cancelled',observation:proposalObservation()}).success).toBe(false);
});
it('a text completion refers only to its actual prepared/provider evidence, never an asset publication',()=>{
 const result={version:1,kind:'logo_vector_proposal',preparedId:proposalId(1),providerResponseReceiptId:proposalId(2)};
 expect(logoVectorProposalStepOutputSchema.safeParse(result).success).toBe(true);
 expect(logoVectorProposalStepOutputSchema.safeParse({...result,publicationId:proposalId(3)}).success).toBe(false);
});
