import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("server-only",()=>({}));
import { createDevelopmentStrategyQueue } from "../../worker/shared-pool/development-queue";
import { sharedConfiguration } from "./shared-pool-fixture";
const directories:string[]=[];
afterEach(async()=>{vi.useRealTimers();await Promise.all(directories.splice(0).map(directory=>rm(directory,{recursive:true,force:true})));});
async function setup(){const directory=await mkdtemp(path.join(tmpdir(),"embel-queue-"));directories.push(directory);const config=sharedConfiguration().queue;return{directory,config,queue:createDevelopmentStrategyQueue(config,directory)};}
describe("development durable broker using real files",()=>{
 it("keeps actual publication receipts and acknowledgements across broker restarts",async()=>{
  const{directory,config,queue}=await setup(),payload={jobId:"example"},receipt=await queue.send(config.topic,payload,{idempotencyKey:"job:1"});
  expect(receipt.messageId).toMatch(/^[0-9a-f-]{36}$/);
  const restarted=createDevelopmentStrategyQueue(config,directory);
  expect(await restarted.send(config.topic,payload,{idempotencyKey:"job:1"})).toEqual(receipt);
  const handler=vi.fn(async()=>{});expect(await restarted.receive(config.topic,config.consumerGroup,handler)).toEqual({ok:true});
  expect(handler).toHaveBeenCalledWith(payload,expect.objectContaining({messageId:receipt.messageId,deliveryCount:1,region:"local"}));
  const again=createDevelopmentStrategyQueue(config,directory);
  expect(await again.receive(config.topic,config.consumerGroup,handler)).toEqual({ok:false,reason:"empty"});
  expect(await again.send(config.topic,payload,{idempotencyKey:"job:1"})).toEqual(receipt);
  await expect(again.send(config.topic,{jobId:"changed"},{idempotencyKey:"job:1"})).rejects.toThrow("unavailable");
 });
 it("persists uncertain delivery visibility and retries after restart without claiming success",async()=>{
  const{directory,config,queue}=await setup();const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now);
  await queue.send(config.topic,{jobId:"pending"},{idempotencyKey:"pending"});
  await expect(queue.receive(config.topic,config.consumerGroup,async()=>{throw Error("provider_unknown");},{retry:()=>({afterSeconds:60})})).rejects.toThrow("provider_unknown");
  const restarted=createDevelopmentStrategyQueue(config,directory),handler=vi.fn(async()=>{});
  expect(await restarted.receive(config.topic,config.consumerGroup,handler)).toEqual({ok:false,reason:"empty"});
  vi.mocked(Date.now).mockReturnValue(now+61000);
  expect(await restarted.receive(config.topic,config.consumerGroup,handler)).toEqual({ok:true});
  expect(handler).toHaveBeenCalledWith({jobId:"pending"},expect.objectContaining({deliveryCount:2}));vi.restoreAllMocks();
 });
 it("holds a running handler exclusively even after its visibility expires",async()=>{
  const{config,queue}=await setup();await queue.send(config.topic,{jobId:"slow"},{idempotencyKey:"slow"});
  let release!:()=>void,entered!:()=>void;const active=new Promise<void>(resolve=>{entered=resolve;});
  const running=queue.receive(config.topic,config.consumerGroup,async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});},{visibilityTimeoutSeconds:30});
  await active;const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+31000);
  expect(await queue.receive(config.topic,config.consumerGroup,async()=>{throw Error("duplicate");})).toEqual({ok:false,reason:"empty"});
  release();expect(await running).toEqual({ok:true});vi.restoreAllMocks();
 });
});
