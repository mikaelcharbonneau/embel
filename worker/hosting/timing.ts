/** Bounds waiting, not remote side effects. Late sends remain safe via the outbox key. */
export async function bounded<T>(work: Promise<T>, signal: AbortSignal, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("Operation deadline reached"));
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, milliseconds);
      if (signal.aborted) abort();
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}
