import { describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
vi.mock("server-only", () => ({}));
import { createLogoVectorProcessRunner } from "../../../src/server/image-process/process";
import { syntheticConversionInput } from "./raster-fixtures";

describe("killable conversion process", () => {
  it("kills a hung real child at the total deadline", async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    const run = createLogoVectorProcessRunner({ timeoutMs: 60, launch: () => {
      child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] });
      return child;
    } });
    const input = syntheticConversionInput("mascot");
    await expect(run(input, new AbortController().signal)).rejects.toMatchObject({ code: "timeout" });
    expect(child?.signalCode).toBe("SIGKILL");
  });
  it("kills a child on cancellation and fences late successful output", async () => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = vi.fn(() => { setTimeout(() => { child.stdout.emit("data", Buffer.from('{"status":"ok"}')); child.emit("close", null, "SIGKILL"); }, 5); return true; });
    const run = createLogoVectorProcessRunner({ launch: () => child as never });
    const controller = new AbortController();
    const promise = run(syntheticConversionInput("emblem"), controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("bounds malformed child output rather than parsing an unbounded response", async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    const run = createLogoVectorProcessRunner({ timeoutMs: 5_000, launch: () => {
      child = spawn(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(8400000,32));setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] });
      return child;
    } });
    await expect(run(syntheticConversionInput("emblem"), new AbortController().signal)).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(child?.signalCode).toBe("SIGKILL");
  });
});
