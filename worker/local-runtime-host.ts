import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { LOCAL_WORKER_ORIGIN, type createLocalChatGPTRuntime } from "./local-chatgpt";
import type { createLogoWorkerRuntime } from "./logo-runtime";

export type LocalRuntimeHostOptions = {
  runtime: Pick<ReturnType<typeof createLocalChatGPTRuntime>, "handle" | "refreshReadiness" | "tick" | "close">;
  logoRuntime?: Pick<ReturnType<typeof createLogoWorkerRuntime>, "refreshReadiness" | "tick" | "close">;
  signal: AbortSignal;
  onListening?: () => void;
};

/** Hosts already-constructed runtimes only. No environment lookup, pool creation
 * or dependency cleanup. Caller-owned connections may close after this resolves. */
export async function runLocalRuntimeHost(options: LocalRuntimeHostOptions): Promise<void> {
  const runtime = options.runtime;
  const controller = new AbortController(), timers: ReturnType<typeof setInterval>[] = [], loops: Promise<void>[] = [];
  const pendingRefreshes: (() => Promise<unknown> | undefined)[] = [], closeDrains: Promise<unknown>[] = [];
  let stopping = false, runtimesClosed = false, closing: Promise<void> | undefined, serverFailure: Error | undefined;
  const closeRuntimes = () => {
    if (runtimesClosed) return;
    runtimesClosed = true;
    // Cleanup is best-effort for both capabilities; never expose raw failures.
    try { closeDrains.push(Promise.resolve(runtime.close()).catch(() => {})); } catch {}
    try { closeDrains.push(Promise.resolve(options.logoRuntime?.close()).catch(() => {})); } catch {}
  };
  let server: ReturnType<typeof createServer>;
  try {
    server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (incoming, outgoing) => {
      try {
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        // Reject an oversized body before constructing a Web Request. The factory
        // independently enforces the same boundary for test and non-HTTP callers.
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of incoming) {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += part.byteLength;
          if (bytes > 4096) { outgoing.writeHead(413, { "Cache-Control": "no-store" }); outgoing.end(); return; }
          chunks.push(part);
        }
        const method = incoming.method ?? "GET";
        const response = await runtime.handle(new Request(new URL(incoming.url ?? "/", LOCAL_WORKER_ORIGIN), { method, headers,
          ...(method !== "GET" && method !== "HEAD" ? { body: Buffer.concat(chunks) } : {}) }));
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch { if (!outgoing.headersSent) outgoing.writeHead(503, { "Cache-Control": "no-store" }); outgoing.end(); }
    });
  } catch (error) { closeRuntimes(); await Promise.allSettled(closeDrains); throw error; }
  const stop = () => {
    if (stopping) return;
    stopping = true; controller.abort(); timers.forEach(clearInterval); closeRuntimes();
    closing = new Promise(resolve => {
      try { server.close(() => resolve()); }
      catch { resolve(); }
    });
    try { server.closeIdleConnections(); } catch {}
  };
  const failed = (error: Error) => { serverFailure = error; stop(); };
  server.on("error", failed);
  options.signal.addEventListener("abort", stop, { once: true });
  function schedule(refresh: () => Promise<unknown>, tick: () => Promise<unknown>) {
    if (controller.signal.aborted) return;
    let pending: Promise<unknown> | undefined;
    const report = () => {
      if (controller.signal.aborted) return Promise.resolve();
      return pending ??= Promise.resolve().then(() => {
        if (!controller.signal.aborted) return refresh();
      }).catch(() => {}).finally(() => { pending = undefined; });
    };
    pendingRefreshes.push(() => pending);
    const timer = setInterval(() => { void report(); }, 20_000); timer.unref(); timers.push(timer);
    loops.push((async () => {
      await report();
      while (!controller.signal.aborted) {
        // Each runtime owns durable retry/uncertainty policy; the host just polls.
        await Promise.resolve().then(() => { if (!controller.signal.aborted) return tick(); }).catch(() => {});
        if (!controller.signal.aborted) await delay(1000, undefined, { signal: controller.signal }).catch(() => {});
      }
    })());
  }
  try {
    if (options.signal.aborted) { stop(); return; }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true; server.removeListener("listening", ready); controller.signal.removeEventListener("abort", aborted); action();
      };
      const ready = () => finish(resolve), aborted = () => finish(resolve);
      server.once("listening", ready); controller.signal.addEventListener("abort", aborted, { once: true });
      try { server.listen(3107, "127.0.0.1"); } catch (error) { finish(() => reject(error)); }
    });
    if (serverFailure) throw serverFailure;
    if (stopping) return;
    options.onListening?.();
    schedule(() => runtime.refreshReadiness(), () => runtime.tick(controller.signal));
    const logo = options.logoRuntime;
    // Closing the logo runtime immediately fences new work. Let an existing
    // bounded tick retain its receipts/publications instead of aborting it here.
    if (logo) schedule(() => logo.refreshReadiness(), () => logo.tick());
    await Promise.all(loops);
    if (serverFailure) throw serverFailure;
  } finally {
    stop();
    await Promise.allSettled(loops);
    await Promise.allSettled([...pendingRefreshes.map(read => read()), ...closeDrains]);
    await closing;
    server.removeListener("error", failed); options.signal.removeEventListener("abort", stop);
  }
}
