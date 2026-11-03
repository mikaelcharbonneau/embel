import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedRuntimeReadyLanes } from "../../scripts/development/shared-runtime.mjs";
const event=(second,value)=>`2026-11-02T22:00:${String(second).padStart(2,"0")}.123456789Z ${JSON.stringify(value)}`;
const ready=lane=>({event:"development_shared_worker_lane_ready",lane});
test("readiness merges both streams and a later failed renewal revokes a lane",()=>{
 const stdout=[event(1,ready("strategy")),event(2,ready("naming")),event(3,ready("logo"))].join("\n");
 const stderr=event(4,{event:"shared_worker_pool_diagnostic",lane:"logo",code:"renewal_failed"});
 assert.deepEqual(sharedRuntimeReadyLanes(stdout,stderr),["naming","strategy"]);
 assert.deepEqual(sharedRuntimeReadyLanes(stdout+"\n"+event(5,ready("logo")),stderr),["logo","naming","strategy"]);
});
test("independent Strategy retries keep a qualified slot available without granting readiness",()=>{
 assert.deepEqual(sharedRuntimeReadyLanes(JSON.stringify(ready("logo")),event(1,ready("other"))),[]);
 for (const code of ["strategy_poll_failed", "strategy_observation_delayed"]) {
  const retry = event(2, {event:"shared_worker_pool_diagnostic", lane:"strategy", code});
  assert.deepEqual(sharedRuntimeReadyLanes("", retry), []);
  assert.deepEqual(sharedRuntimeReadyLanes(event(1, ready("strategy")), retry), ["strategy"]);
 }
});
test("a fault clears old lanes and a restart needs fresh qualifications",()=>{
 const initial=[event(0,{event:"shared_worker_pool_starting"}),event(1,ready("naming")),event(2,ready("logo"))].join("\n");
 const fault=event(3,{event:"shared_worker_pool_process_fault",kind:"uncaught_exception",reason:"connection_lost"});
 assert.deepEqual(sharedRuntimeReadyLanes(initial+"\n"+event(4,ready("strategy")),fault),[]);
 const restarted=initial+"\n"+event(5,{event:"shared_worker_pool_starting"})+"\n"+event(6,ready("strategy"));
 assert.deepEqual(sharedRuntimeReadyLanes(restarted,fault),["strategy"]);
});
