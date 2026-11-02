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
test("uncertified logs cannot advertise readiness and transient outbox retries do not withdraw the slot",()=>{
 assert.deepEqual(sharedRuntimeReadyLanes(JSON.stringify(ready("logo")),event(1,ready("other"))),[]);
 assert.deepEqual(sharedRuntimeReadyLanes(event(1,ready("strategy")),event(2,{event:"shared_worker_pool_diagnostic",lane:"strategy",code:"strategy_poll_failed"})),["strategy"]);
});
