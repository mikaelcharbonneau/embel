import type { TestDatabase } from './local-supabase';

/** Explicit synthetic fixture heartbeat through the real reporter and actual
 * restricted session_user. Callers must separately seed the exact principal and
 * policy. This never replaces auth helpers, synthesizes readiness rows, derives
 * a manifest from all enabled policies, or makes future reports automatic. */
export async function reportLogoFixtureReady(db:TestDatabase,role:string,workerIds:readonly string[],manifest:readonly unknown[]):Promise<void>{
 if(!/^fixture_[a-z0-9_]+$/.test(role))throw new Error('Expected a disposable fixture role');
 await db.exec(`grant execute on function public.report_logo_worker_ready(text,jsonb,integer) to ${role}; set session authorization ${role}`);
 try{for(const workerId of workerIds){const r=await db.query<{ready:boolean}>('select public.report_logo_worker_ready($1,$2,90) ready',[workerId,manifest]);if(r.rows[0]?.ready!==true)throw new Error('Fixture readiness report rejected');}}
 finally{await db.exec('set session authorization postgres');}
}
export const SYNTHETIC_CONCEPT_READINESS={operation:'identity.logo_concept',policyIdentity:'a'.repeat(64),handlerVersion:'logo-image-v1',provider:'openai',model:'gpt-image-2.5-sunburst-2026-09-08',engine:null,maxCostMicrousd:100} as const;
