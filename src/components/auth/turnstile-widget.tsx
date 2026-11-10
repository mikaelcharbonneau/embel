"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

/** Cloudflare Turnstile through Supabase Auth. Off until a public site key is configured. */
export function turnstileSiteKey(): string | null {
  // Written out in full so Next.js can inline the build-time value into the browser bundle.
  return process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || null;
}

export interface TurnstileHandle {
  /** The current single-use token, or null while the check is running, expired or failed. */
  token(): string | null;
  /** Whether the check failed to load or run, so the person should refresh. */
  failed(): boolean;
  /** A token works once. Call after every submit attempt to get a fresh one. */
  reset(): void;
}

interface TurnstileApi {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}
declare global { interface Window { turnstile?: TurnstileApi } }

// The official script has a fixed, unversioned address; Cloudflare serves the current v0 build.
const scriptUrl = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptLoading: Promise<TurnstileApi> | null = null;

function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptLoading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = scriptUrl;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile_missing")));
    script.onerror = () => { script.remove(); scriptLoading = null; reject(new Error("turnstile_blocked")); };
    document.head.append(script);
  });
  return scriptLoading;
}

/** Returns the token to send, nothing when the check is off, or a message explaining why to wait. */
export function readCaptcha(handle: TurnstileHandle | null): { ok: true; token?: string } | { ok: false; message: string } {
  if (!turnstileSiteKey()) return { ok: true };
  const token = handle?.token();
  if (token) return { ok: true, token };
  return { ok: false, message: handle?.failed()
    ? "The security check couldn't load. Refresh the page or check your connection, then try again."
    : "Please wait for the security check to finish, then try again." };
}

export function TurnstileWidget({ handleRef }: { handleRef: Ref<TurnstileHandle> }) {
  const siteKey = turnstileSiteKey();
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const token = useRef<string | null>(null);
  const failed = useRef(false);

  useImperativeHandle(handleRef, () => ({
    token: () => token.current,
    failed: () => failed.current,
    reset() {
      token.current = null;
      if (widgetId.current !== null) window.turnstile?.reset(widgetId.current);
    },
  }), []);

  useEffect(() => {
    if (!siteKey || !container.current) return;
    let cancelled = false;
    const element = container.current;
    loadScript().then(api => {
      if (cancelled) return;
      widgetId.current = api.render(element, {
        sitekey: siteKey,
        theme: "auto",
        size: "flexible",
        callback: (value: string) => { token.current = value; failed.current = false; },
        "expired-callback": () => { token.current = null; },
        "timeout-callback": () => { token.current = null; },
        "error-callback": () => { token.current = null; failed.current = true; },
      });
    }).catch(() => { failed.current = true; });
    return () => {
      cancelled = true;
      if (widgetId.current !== null) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
      token.current = null;
    };
  }, [siteKey]);

  if (!siteKey) return null;
  return <div ref={container} className="auth-captcha" />;
}
