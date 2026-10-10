export class DomainReadTimeout extends Error {}
export class DomainReadCancelled extends Error {}

/** Settle independently of adapters that ignore AbortSignal; consume late outcomes. */
export function boundedDomainRead<T>(read: (signal: AbortSignal) => Promise<T>, controller: AbortController, timeoutMs = 15_000): Promise<T> {
  if (controller.signal.aborted) return Promise.reject(new DomainReadCancelled());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (publish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancel);
      publish();
    };
    const cancel = () => finish(() => reject(new DomainReadCancelled()));
    const timer = setTimeout(() => {
      finish(() => reject(new DomainReadTimeout()));
      controller.abort();
    }, timeoutMs);
    controller.signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new DomainReadCancelled();
      return read(controller.signal);
    }).then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
