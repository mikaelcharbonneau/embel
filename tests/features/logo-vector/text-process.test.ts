import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLogoTextProcessRunner } from "../../../worker/logo-vector/text-process";
import { licensedTextInput } from "./text-fixtures";

describe("bounded isolated text process", () => {
  it("kills a hung actual child at its total deadline", async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    const run = createLogoTextProcessRunner({ timeoutMs: 60, launch: () => {
      child = spawn(process.execPath, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] }); return child;
    } });
    await expect(run(licensedTextInput("A"), new AbortController().signal)).rejects.toMatchObject({ code: "timeout" });
    expect(child?.signalCode).toBe("SIGKILL");
  });
  it("refuses an unbounded or longer-than-five-second configured deadline", () => {
    expect(() => createLogoTextProcessRunner({ timeoutMs: 5001 })).toThrow();
    expect(() => createLogoTextProcessRunner({ timeoutMs: 0 })).toThrow();
  });
  it("cancels the process and fences late successful output", async () => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = vi.fn(() => { setTimeout(() => { child.stdout.emit("data", Buffer.from('{"status":"ok"}')); child.emit("close", null, "SIGKILL"); }, 5); return true; });
    const controller = new AbortController(), run = createLogoTextProcessRunner({ launch: () => child as never });
    const pending = run(licensedTextInput("A"), controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" }); expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("rejects pre-aborted or oversized input before launching a child", async () => {
    const launch = vi.fn(), run = createLogoTextProcessRunner({ launch });
    const controller = new AbortController(); controller.abort();
    await expect(run(licensedTextInput("A"), controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    const input = licensedTextInput("A"); input.font.bytes = new Uint8Array(10_485_761);
    await expect(run(input, new AbortController().signal)).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(launch).not.toHaveBeenCalled();
  });
  it("kills a child exceeding the result byte ceiling", async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    const run = createLogoTextProcessRunner({ launch: () => {
      child = spawn(process.execPath, ["-e", "process.stdin.resume();process.stdout.write(Buffer.alloc(8400000,32));setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] }); return child;
    } });
    await expect(run(licensedTextInput("A"), new AbortController().signal)).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(child?.signalCode).toBe("SIGKILL");
  });
  it("rejects a malformed child response without exposing private parser diagnostics", async () => {
    const run = createLogoTextProcessRunner({ launch: () => spawn(process.execPath, ["-e", "process.stdin.resume();process.stdout.write('PRIVATE BAD OUTPUT');"], { stdio: ["pipe", "pipe", "pipe"] }) });
    await expect(run(licensedTextInput("A"), new AbortController().signal)).rejects.toMatchObject({ code: "conversion_failed", message: expect.not.stringContaining("PRIVATE") });
  });
});
