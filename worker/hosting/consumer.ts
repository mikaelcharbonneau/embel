import type { RetryHandler } from "@vercel/queue";
import { bounded } from "./timing";
import { diagnose, diagnosticErrorClass, type DiagnosticSink } from "./diagnostics";

class BackgroundObservationPending extends Error {}

export async function handleApiTextQueueRequest(request: Request, dependencies: {
  queue: { handleCallback(handler: (message: unknown) => Promise<void>, options: {
    visibilityTimeoutSeconds: number; retry: RetryHandler;
  }): (request: Request) => Promise<Response> };
  diagnostics?: DiagnosticSink;
  deliver(message: unknown, signal: AbortSignal): Promise<{ disposition: "ack" | "retry"; state: string }>;
}): Promise<Response> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 270_000);
  try {
    // Per-request closure: no shared abort state between concurrent Embel invocations.
    const callback = dependencies.queue.handleCallback(async (message: unknown) => {
      controller.signal.throwIfAborted();
      const result = await dependencies.deliver(message, controller.signal);
      controller.signal.throwIfAborted();
      diagnose("delivery", result.disposition === "ack" ? "terminal_ack_requested" : "retry_requested", started, "none", dependencies.diagnostics);
      if (result.disposition !== "ack") {
        if (result.state === "background_observing") throw new BackgroundObservationPending("Background observation pending");
        throw new Error("Delivery requires recheck");
      }
    }, {
      visibilityTimeoutSeconds: 300,
      // Exhaustion is never success. The generation-fenced SQL outbox owns redrive.
      retry: (error, metadata) => {
        diagnose("queue_callback", "retry_requested", started, "none", dependencies.diagnostics);
        return { afterSeconds: error instanceof BackgroundObservationPending ? 2 : Math.min(300, 60 * metadata.deliveryCount) };
      },
    });
    // SDK receive/lease cleanup/ack are included, not only the provider callback.
    const response = await bounded(callback(request), controller.signal, 270_000);
    // SDK HTTP 200 confirms transport handling, NOT receipt persistence or job success.
    diagnose("queue_callback", response.ok ? "transport_success" : "transport_failure", started, "none", dependencies.diagnostics);
    return response;
  } catch (error) {
    diagnose("queue_callback", "error", started, diagnosticErrorClass(error, "queue"), dependencies.diagnostics);
    throw error;
  } finally { clearTimeout(timer); controller.abort(); }
}
