import { expect,it,vi } from 'vitest';
vi.mock('server-only',()=>({}));
import { logoVectorProposalProviderObservationSchema,logoVectorProposalRecordSchema } from '@/domain/logo-vector-proposal-jobs';
import { proposalObservation,proposalRecord } from '../server/logo-vector-proposal-fixtures';
it('retains interruption with a nullable actually observed model and no invented bill',()=>{
 expect(logoVectorProposalProviderObservationSchema.safeParse({...proposalObservation(),model:null,responseComplete:false,toolCalls:null,usage:null,billing:{status:'unknown',confirmedMicrousd:null}}).success).toBe(true);
});
it('cannot infer successful completion merely from a response ID, hash and usage',()=>{
 const r=proposalRecord();expect(logoVectorProposalRecordSchema.safeParse({...r,providerReceipt:{...r.providerReceipt,observation:{...r.providerReceipt.observation,responseComplete:false,toolCalls:0}}}).success).toBe(false);
});
it('does not classify unknown or unexpected tool usage as known zero-tool billing',()=>{
 for(const toolCalls of [null,1])expect(logoVectorProposalProviderObservationSchema.safeParse({...proposalObservation(),responseComplete:true,toolCalls}).success).toBe(false);
});

it('accepts a complete exactly observed zero-tool response as evidence',()=>{expect(logoVectorProposalProviderObservationSchema.safeParse(proposalObservation()).success).toBe(true);expect(logoVectorProposalRecordSchema.safeParse(proposalRecord()).success).toBe(true);});
