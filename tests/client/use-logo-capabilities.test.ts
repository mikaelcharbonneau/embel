// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useLayoutEffect, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AccountSessionProvider, useAccountSession } from "@/components/workspace/account-session";
import { createAccountLogoClient } from "@/components/identity/account-logo-client";
import { useLogoCapabilities } from "@/components/identity/use-logo-capabilities";
import { logoOperationSchema } from "@/domain/logo-jobs";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; vi.unstubAllGlobals(); });
async function until(check: () => void) { let error: unknown; for (let i = 0; i < 50; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); try { check(); return; } catch (e) { error = e; } } throw error; }
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let owner = id(1), controls: ReturnType<typeof useAccountSession> | undefined, value: ReturnType<typeof useLogoCapabilities> | undefined;
  const requests: { owner: string; signal: AbortSignal | null | undefined; response: ReturnType<typeof deferred<Response>> }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    if (url === "/api/session") return Response.json({ user: { id: owner } });
    if (url === "/api/auth/sign-out") return Response.json({ authenticated: false });
    if (String(url).endsWith("/capabilities")) { const response = deferred<Response>(); requests.push({ owner, signal: init?.signal, response }); return response.promise; }
    throw new Error(`Unexpected non-capability operation ${String(url)}`);
  };
  vi.stubGlobal("fetch", fetcher);
  function Harness() {
    const account = useAccountSession(), verified = account.session.status === "ready" ? account.session : null;
    const client = useMemo(() => verified ? createAccountLogoClient(verified, id(2), account.isCurrent, account.expire, fetcher) : null, [verified, account.isCurrent, account.expire]);
    const readiness = useLogoCapabilities(client, id(2));
    useLayoutEffect(() => { controls = account; value = readiness; });
    return createElement("p", null, readiness.isAvailable("identity.logo_vectorize") ? "Vector conversion ready" : "Conversion unavailable");
  }
  const container = document.createElement("div"); root = createRoot(container);
  await act(async () => root!.render(createElement(AccountSessionProvider, null, createElement(Harness))));
  await until(() => expect(requests).toHaveLength(1));
  function reply(index: number) { const request = requests[index]!, now = Date.now(); request.response.resolve(Response.json({ ownerId: request.owner, projectId: id(2), observedAt: new Date(now).toISOString(), operations: Object.fromEntries(logoOperationSchema.options.map(operation => [operation, operation === "identity.logo_vectorize" ? { status: "available", expiresAt: new Date(now + 30_000).toISOString() } : { status: "unavailable" }])) })); }
  return { container, requests, reply, get value() { return value!; }, async switchOwner() { owner = id(3); await act(async () => controls!.refresh()); }, async logout() { await act(async () => { await controls!.signOut(); }); } };
}
describe("mounted operation readiness privacy", () => {
  it("hides old scope during account change, aborts the old read and fences its late reply", async () => {
    const s = await mount(); await s.switchOwner(); expect(s.value.isAvailable("identity.logo_vectorize")).toBe(false);
    expect(s.requests[0]!.signal?.aborted).toBe(true); await until(() => expect(s.requests).toHaveLength(2));
    await act(async () => s.reply(0)); expect(s.container.textContent).toBe("Conversion unavailable");
    await act(async () => s.reply(1)); await until(() => expect(s.container.textContent).toBe("Vector conversion ready"));
  });
  it("hides available capabilities immediately on logout and aborts a pending refresh", async () => {
    const s = await mount(); await act(async () => s.reply(0)); await until(() => expect(s.value.isAvailable("identity.logo_vectorize")).toBe(true));
    let refresh!: Promise<void>; await act(async () => { refresh = s.value.refresh(); }); expect(s.requests).toHaveLength(2);
    await s.logout(); expect(s.value.status).toBe("unverified"); expect(s.value.isAvailable("identity.logo_vectorize")).toBe(false);
    expect(s.requests[1]!.signal?.aborted).toBe(true); await act(async () => { s.reply(1); await refresh; }); expect(s.container.textContent).toBe("Conversion unavailable");
  });
});
