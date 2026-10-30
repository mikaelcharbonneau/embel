/** Failed/standby slots retry independently of healthy work and lease renewal.
 * Equal jitter keeps concurrent restarts apart without allowing a zero delay. */
export function createSharedPoolBackoff(idlePollMs:number,random:()=>number=Math.random){
 const base=Math.min(30_000,Math.max(1000,idlePollMs));let attempt=0;
 return{reset(){attempt=0;},next(){
  attempt=Math.min(attempt+1,32);const ceiling=Math.min(30_000,base*2**Math.min(attempt-1,5));
  const sample=random(),jitter=Number.isFinite(sample)?Math.min(1,Math.max(0,sample)):0.5;
  return{attempt,retryAfterMs:Math.round(ceiling*(0.5+jitter*0.5))};
 }};
}
