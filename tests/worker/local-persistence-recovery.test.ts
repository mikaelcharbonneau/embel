import { expect, it, vi } from 'vitest';
import { retryLocalPersistence, reportNamingFailure, LocalNamingFailure } from '../../worker/local-persistence-recovery';
it('retries only transient local errors with a bounded backoff', async () => {
 const error=Object.assign(new Error('private payload must not be logged'),{code:'ECONNRESET'});
 const work=vi.fn().mockRejectedValue(error),wait=vi.fn().mockResolvedValue(undefined);
 await expect(retryLocalPersistence(work,new AbortController().signal,wait)).rejects.toBe(error);
 expect(work).toHaveBeenCalledTimes(3);expect(wait.mock.calls).toEqual([[100],[200]]);
});
it('never retries validation, permissions, conflicts or unknown errors',async()=>{
 for(const code of ['22023','42501','23505',undefined]){
  const work=vi.fn().mockRejectedValue(Object.assign(new Error('private'),{code}));
  await expect(retryLocalPersistence(work,new AbortController().signal)).rejects.toThrow();expect(work).toHaveBeenCalledOnce();
 }
});
it('stops before another write after cancellation during backoff',async()=>{
 const controller=new AbortController(),work=vi.fn().mockRejectedValue(Object.assign(new Error('private'),{code:'ECONNRESET'}));
 await expect(retryLocalPersistence(work,controller.signal,async()=>controller.abort())).rejects.toThrow('local_recovery_cancelled');expect(work).toHaveBeenCalledOnce();
});
it('does not log raw errors or invoke a hostile code getter',()=>{
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{}),getter=vi.fn(()=>{throw Error('secret');});
 const error=Object.defineProperty({},'code',{get:getter});reportNamingFailure(new LocalNamingFailure('planning',error),'unknown');
 expect(getter).not.toHaveBeenCalled();expect(warn).toHaveBeenCalledExactlyOnceWith(JSON.stringify({event:'naming_local_failure',phase:'planning',errorClass:'unclassified'}));warn.mockRestore();
});

it('retains a known completed artifact once after cancellation without retrying',async()=>{
 const controller=new AbortController();controller.abort();
 const work=vi.fn().mockResolvedValue('retained');
 await expect(retryLocalPersistence(work,controller.signal,undefined,true)).resolves.toBe('retained');
 expect(work).toHaveBeenCalledOnce();
 const failed=vi.fn().mockRejectedValue(Object.assign(new Error('private'),{code:'ECONNRESET'}));
 await expect(retryLocalPersistence(failed,controller.signal,undefined,true)).rejects.toThrow('private');expect(failed).toHaveBeenCalledOnce();
});
