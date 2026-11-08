"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useAccountSession } from "@/components/workspace/account-session";
import { createStandaloneLiveAdapters, loadStandaloneCapabilities } from "@/components/tools/standalone-live-client";
import { availabilityAt, DomainLookupError, readDomainCheck } from "@/features/domain-workspace/model";
import { projectScreeningDomainSuggestion } from "./project-screening-domain";

/** "unknown": the registry answered without confirming either way.
 * "unchecked": the check failed, timed out or gave up waiting. */
type Status = "checking" | "available" | "taken" | "unknown" | "unchecked";
type Adapters = ReturnType<typeof createStandaloneLiveAdapters>;

// One lookup may take this long before it is abandoned and shown as not
// checked; nothing is guessed. A name waiting its turn behind the account's
// lookup limit keeps waiting: the queue resumes when the limit allows.
const LOOKUP_TIMEOUT = 15_000;

// One shared checker per signed-in account: results are reused for the page's
// lifetime and one lookup runs at a time, as the server admits one in-flight
// lookup per account (a second is refused and would pause the whole queue for a
// minute). A failed or unconfirmed lookup is never shown as available.
const results = new Map<string, Status>();
const listeners = new Map<string, Set<() => void>>();
const queue: string[] = [];
let running = 0, pausedUntil = 0, resume: ReturnType<typeof setTimeout> | null = null;
let checker: { key: string; adapters: Promise<Adapters | null>; controller: AbortController } | null = null;

function publish(domain: string, status: Status) {
  results.set(domain, status);
  for (const listener of listeners.get(domain) ?? []) listener();
}

function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, parent: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Check timed out")); }, LOOKUP_TIMEOUT); });
  return Promise.race([work(controller.signal), timeout]).finally(() => { clearTimeout(timer); parent.removeEventListener("abort", abort); });
}

function request(domain: string) {
  if (results.has(domain)) return;
  publish(domain, "checking"); queue.push(domain); pump();
}

function pump() {
  if (Date.now() < pausedUntil) {
    resume ??= setTimeout(() => { resume = null; pump(); }, pausedUntil - Date.now());
    return;
  }
  while (running < 1 && queue.length && checker) {
    const domain = queue.shift()!;
    const current = checker;
    running += 1;
    void current.adapters.then(async adapters => {
      // A replaced checker (new sign-in or session) asks again for names on screen.
      if (checker !== current) return;
      if (!adapters || adapters.domains.status === "unavailable") return publish(domain, "unchecked");
      try {
        const check = await withTimeout(signal => readDomainCheck(adapters.domains, domain, signal), current.controller.signal);
        if (checker !== current) return;
        const availability = check.domain === domain ? availabilityAt(check, Date.now()) : "unknown";
        publish(domain, availability === "available" ? "available" : availability === "taken" ? "taken" : "unknown");
      } catch (error) {
        if (checker !== current) return;
        // The account's lookup limit: wait as asked, then check this name again.
        if (error instanceof DomainLookupError && error.retryAfterSeconds !== null && !current.controller.signal.aborted) {
          pausedUntil = Math.max(pausedUntil, Date.now() + error.retryAfterSeconds * 1000);
          queue.unshift(domain);
        } else publish(domain, "unchecked");
      }
    }).finally(() => { running -= 1; pump(); });
  }
}

/** Outside a signed-in workspace (for example a static preview) nothing is checked. */
function useOptionalAccountSession() {
  try { return useAccountSession(); } catch { return null; }
}

function useChecker() {
  const account = useOptionalAccountSession();
  const session = account?.session;
  const isCurrent = account?.isCurrent;
  const key = session?.status === "ready" ? `${session.userId}:${session.generation}` : null;
  useEffect(() => {
    if (!key || session?.status !== "ready" || !isCurrent || checker?.key === key) return;
    checker?.controller.abort();
    results.clear(); queue.length = 0;
    const controller = new AbortController();
    const captured = session;
    const binding = { ownerId: captured.userId, signal: controller.signal, isCurrent: () => isCurrent(captured) };
    checker = { key, controller, adapters: loadStandaloneCapabilities(binding).then(caps => createStandaloneLiveAdapters(caps, binding)).catch(() => null) };
    pump();
  }, [key, session, isCurrent]);
  return key;
}

/** The .com status of a visible name, from the shared domain check. */
export function DotComStatus({ name }: { name: string }) {
  const checkerKey = useChecker(), ready = Boolean(checkerKey);
  const domain = projectScreeningDomainSuggestion(name);
  const element = useRef<HTMLSpanElement>(null);
  const subscribe = useCallback((listener: () => void) => {
    if (!domain) return () => {};
    const set = listeners.get(domain) ?? new Set();
    set.add(listener); listeners.set(domain, set);
    return () => { set.delete(listener); };
  }, [domain]);
  const status = useSyncExternalStore(subscribe, () => domain ? results.get(domain) ?? null : null, () => null);
  // Only names on screen are checked; scrolling further checks the next ones.
  // A new checker (key) clears earlier results, so names on screen ask again.
  useEffect(() => {
    const target = element.current;
    if (!checkerKey || !domain || !target) return;
    if (typeof IntersectionObserver === "undefined") { request(domain); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { request(domain); observer.disconnect(); } });
    observer.observe(target);
    return () => observer.disconnect();
  }, [checkerKey, domain]);
  if (!domain) return null;
  // Without a signed-in account nothing is checked.
  const shown: Status = status ?? (ready ? "checking" : "unchecked");
  const label = shown === "checking" ? "Checking .com…" : shown === "available" ? ".com available" : shown === "taken" ? ".com taken" : shown === "unknown" ? ".com not confirmed" : ".com not checked";
  return <span ref={element} className="naming-dot-com" data-status={shown}><span aria-hidden="true" />{label}</span>;
}
