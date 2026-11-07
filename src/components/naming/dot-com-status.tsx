"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useAccountSession } from "@/components/workspace/account-session";
import { createStandaloneLiveAdapters, loadStandaloneCapabilities } from "@/components/tools/standalone-live-client";
import { availabilityAt, DomainLookupError, readDomainCheck } from "@/features/domain-workspace/model";
import { projectScreeningDomainSuggestion } from "./project-screening-domain";

type Status = "checking" | "available" | "taken" | "unknown";
type Adapters = ReturnType<typeof createStandaloneLiveAdapters>;

// One shared checker per signed-in account: results are reused for the page's
// lifetime and at most two lookups run at once, so a grid of names never floods
// the registry. A failed or unconfirmed lookup is shown as unknown, never guessed.
const results = new Map<string, Status>();
const listeners = new Map<string, Set<() => void>>();
const queue: string[] = [];
let running = 0, pausedUntil = 0, resume: ReturnType<typeof setTimeout> | null = null;
let checker: { key: string; adapters: Promise<Adapters | null>; controller: AbortController } | null = null;

function publish(domain: string, status: Status) {
  results.set(domain, status);
  for (const listener of listeners.get(domain) ?? []) listener();
}

function pump() {
  if (Date.now() < pausedUntil) {
    resume ??= setTimeout(() => { resume = null; pump(); }, pausedUntil - Date.now());
    return;
  }
  while (running < 2 && queue.length && checker) {
    const domain = queue.shift()!;
    const current = checker;
    running += 1;
    void current.adapters.then(async adapters => {
      if (!adapters || adapters.domains.status === "unavailable") return publish(domain, "unknown");
      try {
        const check = await readDomainCheck(adapters.domains, domain, current.controller.signal);
        const availability = check.domain === domain ? availabilityAt(check, Date.now()) : "unknown";
        publish(domain, availability === "available" ? "available" : availability === "taken" ? "taken" : "unknown");
      } catch (error) {
        // The account's lookup limit: wait as asked, then check this name again.
        if (error instanceof DomainLookupError && error.retryAfterSeconds !== null && !current.controller.signal.aborted) {
          pausedUntil = Math.max(pausedUntil, Date.now() + error.retryAfterSeconds * 1000);
          queue.unshift(domain);
        } else publish(domain, "unknown");
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
  return Boolean(key);
}

/** The .com status of a visible name, from the shared domain check. */
export function DotComStatus({ name }: { name: string }) {
  const ready = useChecker();
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
  useEffect(() => {
    const target = element.current;
    if (!ready || !domain || !target) return;
    const request = () => { if (!results.has(domain)) { publish(domain, "checking"); queue.push(domain); pump(); } };
    if (typeof IntersectionObserver === "undefined") { request(); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { request(); observer.disconnect(); } });
    observer.observe(target);
    return () => observer.disconnect();
  }, [ready, domain]);
  if (!domain) return null;
  const label = !status || status === "checking" ? "Checking .com…" : status === "available" ? ".com available" : status === "taken" ? ".com taken" : ".com not confirmed";
  return <span ref={element} className="naming-dot-com" data-status={status ?? "checking"}><span aria-hidden="true" />{label}</span>;
}
