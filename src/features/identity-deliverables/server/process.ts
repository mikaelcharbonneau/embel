import "server-only";
import { fork } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { assertSupportedExportRuntime, LOGO_RENDER_DEADLINE_MS, LogoFileError } from "./render-policy";
declare const __EMBEL_LOGO_RENDER_ENTRYPOINT__: string;

/** Native encoders/parsers are isolated so cancellation and deadline can stop CPU work. */
export function runLogoProcess<T>(input: Record<string, unknown>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  assertSupportedExportRuntime();
  return new Promise((resolve, reject) => {
    const entrypoint =
      typeof __EMBEL_LOGO_RENDER_ENTRYPOINT__ === "string"
        ? __EMBEL_LOGO_RENDER_ENTRYPOINT__
        : "src/features/identity-deliverables/server/render-process.mjs";
    const child = fork(resolvePath(process.cwd(), entrypoint), [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
      execArgv: ["--max-old-space-size=256"],
      // Prevent inherited provider/database credentials and NODE_OPTIONS from reaching decoders.
      env: { NODE_ENV: "production" },
    });
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      child.removeAllListeners();
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(
      () => finish(new LogoFileError("timeout", "Logo rendering exceeded its 60-second limit.")),
      LOGO_RENDER_DEADLINE_MS,
    );
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", () => finish(new LogoFileError("unavailable", "The isolated logo renderer is unavailable.")));
    child.once("exit", () =>
      finish(new LogoFileError("render_failed", "The isolated logo renderer stopped before completion.")),
    );
    child.once("message", (message: unknown) => {
      if (message && typeof message === "object" && "ok" in message && message.ok && "value" in message)
        finish(null, message.value as T);
      else finish(new LogoFileError("render_failed", "The isolated logo renderer rejected the file."));
    });
    child.send(input, (error) => {
      if (error) finish(new LogoFileError("render_failed", "The logo renderer could not receive the file."));
    });
    if (signal.aborted) abort();
  });
}
