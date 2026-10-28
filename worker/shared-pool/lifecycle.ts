import "server-only";
export interface SharedPoolLifecycleController {run(signal:AbortSignal):Promise<void>;close():Promise<void>;}
/** Shutdown begins when signalled, not after run() happens to return. close()
 * owns the configured drain deadline/fence; failure requires host termination,
 * never a stopped-provider claim or release of still-running local capacity. */
export async function runSharedPoolLifecycle(controller:SharedPoolLifecycleController,signal:AbortSignal,termination:{unconfirmed():void;exit(code:2):void}):Promise<void>{
 const lifetime=new AbortController();let closing:Promise<void>|undefined,resolveStop!:()=>void;
 const stopped=new Promise<void>(resolve=>{resolveStop=resolve;});
 const close=()=>closing??=controller.close();
 const abort=()=>{lifetime.abort();resolveStop();void close().catch(()=>{});};
 signal.addEventListener("abort",abort,{once:true});
 const running=signal.aborted?Promise.resolve():controller.run(lifetime.signal);void running.catch(()=>{});
 if(signal.aborted)abort();
 try{await Promise.race([running,stopped]);await close();}
 catch{
  lifetime.abort();try{await close();}catch{ /* Unconfirmed remains a failure, not a fabricated drain. */ }
  termination.unconfirmed();termination.exit(2);throw Error("shared_pool_termination_required");
 }finally{signal.removeEventListener("abort",abort);lifetime.abort();}
}
