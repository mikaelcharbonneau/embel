import { afterEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { runSharedPoolLifecycle } from "../../worker/shared-pool/lifecycle";
afterEach(()=>vi.useRealTimers());
describe("Daemon signal/drain lifecycle (no process termination in tests)",()=>{
 it("does not start receiving or claim slots when already stopped",async()=>{
  const stop=new AbortController();stop.abort();const controller={run:vi.fn(async()=>{}),close:vi.fn(async()=>{})},termination={unconfirmed:vi.fn(),exit:vi.fn()};
  await runSharedPoolLifecycle(controller,stop.signal,termination);expect(controller.run).not.toHaveBeenCalled();expect(controller.close).toHaveBeenCalledOnce();expect(termination.exit).not.toHaveBeenCalled();
 });
 it("starts close immediately on SIGTERM-equivalent signal while actual work is still pending",async()=>{
  const stop=new AbortController();let finish!:()=>void;const actualWork=new Promise<void>(resolve=>{finish=resolve;});
  const controller={run:vi.fn(async()=>actualWork),close:vi.fn(async()=>actualWork)},termination={unconfirmed:vi.fn(),exit:vi.fn()};
  const running=runSharedPoolLifecycle(controller,stop.signal,termination);stop.abort();await Promise.resolve();expect(controller.close).toHaveBeenCalledTimes(1);expect(termination.exit).not.toHaveBeenCalled();
  finish();await running;expect(termination.unconfirmed).not.toHaveBeenCalled();
 });
 it("requires bounded failure exit when a noncooperative handle outlives the drain deadline, without claiming successful drain",async()=>{
  vi.useFakeTimers();const stop=new AbortController();let finish!:()=>void;const actualWork=new Promise<void>(resolve=>{finish=resolve;});
  const controller={run:vi.fn(async()=>actualWork),close:vi.fn(()=>new Promise<void>((_resolve,reject)=>{setTimeout(()=>reject(Error("inert unconfirmed drain")),1000);}))},termination={unconfirmed:vi.fn(),exit:vi.fn()};
  const running=runSharedPoolLifecycle(controller,stop.signal,termination);const rejected=expect(running).rejects.toThrow("termination_required");stop.abort();
  await vi.advanceTimersByTimeAsync(1001);await rejected;expect(termination.exit).toHaveBeenCalledExactlyOnceWith(2);expect(termination.unconfirmed).toHaveBeenCalledOnce();expect(controller.close).toHaveBeenCalledTimes(1);finish();
 });
 it("treats an unexpected run failure as unavailable and drains before host termination",async()=>{
  const order:string[]=[];const controller={run:async()=>{throw Error("inert lane failure");},close:async()=>{order.push("close");}};
  await expect(runSharedPoolLifecycle(controller,new AbortController().signal,{unconfirmed:()=>order.push("failure"),exit:()=>order.push("exit")})).rejects.toThrow("termination_required");
  expect(order).toEqual(["close","failure","exit"]);
 });
});
