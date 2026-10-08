import type { RetryHandler } from "@vercel/queue";
import { bounded } from "./timing";

export async function handleApiTextQueueRequest(request: Request, dependencies: {
  queue: { handleCallback(handler: (message: unknown) => Promise<void>, options: {
    visibilityTimeoutSeconds: number; retry: RetryHandler;
  }): (request: Request) => Promise<Response> };
  deliver(message: unknown, signal: AbortSignal): Promise<{ disposition: "ack" | "retry"; state: string }>;
}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 270_000);
  try {
    // Per-request closure: no shared abort state between concurrent Fluid invocations.
    const callback = dependencies.queue.handleCallback(async (message: unknown) => {
      controller.signal.throwIfAborted();
      const result = await dependencies.deliver(message, controller.signal);
      controller.signal.throwIfAborted();
      if (result.disposition !== "ack") throw new Error("Delivery requires recheck");
    }, {
      visibilityTimeoutSeconds: 300,
      // Exhaustion is never success. The generation-fenced SQL outbox owns redrive.
      retry: (_error, metadata) => ({ afterSeconds: Math.min(300, 60 * metadata.deliveryCount) }),
    });
    // SDK receive/lease cleanup/ack are included, not only the provider callback.
    return await bounded(callback(request), controller.signal, 270_000);
  } finally { clearTimeout(timer); controller.abort(); }
}
