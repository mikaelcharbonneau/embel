// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "@/components/workspace/account-session";
import { NamesWorkspace } from "@/components/naming/names-workspace";
import { createEmptyNamesWorkspace, type AccountNamesWorkspace } from "@/domain/names-workspace";
import { contextSnapshotSchema } from "@/domain/projects";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/naming/account-names-library", () => ({ AccountNamesLibrary: () => createElement("section", {}, "Project names") }));
vi.mock("@/components/naming/standalone-names-assistant", () => ({ StandaloneNamesAssistant: () => null }));
vi.mock("@/features/names-assistant", () => ({ NamesAssistant: () => null }));
const owner = "aaaaaaaa-1111-4111-8111-111111111111", other = "bbbbbbbb-1111-4111-8111-111111111111";
let root: Root, host: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>, currentOwner: string | null, fail: boolean;
const rows = new Map<string, AccountNamesWorkspace>();
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === label || item.textContent === label)!;
async function click(node: HTMLElement) { await act(async () => { node.click(); }); }
async function input(node: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function advance(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function SignOutProbe() {
  const { signOut } = useAccountSession(); const [result, setResult] = useState("");
  return createElement("div", {}, createElement("button", { onClick: () => { void signOut().then(value => setResult(value.ok ? "signed_out" : value.reason)); } }, "Test sign out"), createElement("output", {}, result));
}
async function render() {
  await act(async () => { root.render(<AccountSessionProvider><NamesWorkspace /><SignOutProbe /></AccountSessionProvider>); });
  await advance();
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); rows.clear(); currentOwner = owner; fail = false;
  fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/session") return Response.json(currentOwner ? { user: { id: currentOwner } } : {}, { status: currentOwner ? 200 : 401 });
    if (path === "/api/names/workspace" && currentOwner) {
      if (init?.method === "PUT") {
        if (new Headers(init.headers).get("X-Embel-Account") !== currentOwner) return Response.json({}, { status: 401 });
        if (fail) return Response.json({}, { status: 503 });
        const body = JSON.parse(String(init.body));
        rows.set(currentOwner, { id: "cccccccc-1111-4111-8111-111111111111", ownerId: currentOwner, revision: body.expectedRevision + 1, payload: body.payload, createdAt: "2026-10-15T12:00:00Z", updatedAt: "2026-10-15T12:00:00Z" });
      }
      return Response.json({ ownerId: currentOwner, workspace: rows.get(currentOwner) ?? null });
    }
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("account Names interface", () => {
  it("routes guided actions through the account provider and hides them on an owner change", async () => {
    await render(); const field = host.querySelector<HTMLInputElement>("#names-guided-word")!;
    await input(field, "cedar"); await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await click(button("prefix Neo")); await click(button("Favorite result Neocedar")); await advance(450);
    expect(rows.get(owner)!.payload.candidates.at(-1)!.source.value).toBe("Neocedar");
    expect(host.textContent).toContain("Saved to your account"); expect(localStorage.getItem("fluid.names.v1")).toBeNull();
    await click(button("Library")); expect(host.textContent).toContain("From your projects"); expect(host.textContent).not.toContain("Browser library");
    currentOwner = other; await act(async () => { window.dispatchEvent(new Event("focus")); }); await advance();
    expect(host.textContent).not.toContain("Neocedar"); expect(host.querySelector<HTMLInputElement>("#names-guided-word")!.value).toBe("");
  });

  it("reports unsaved manual names honestly and protects sign-out until retry succeeds", async () => {
    await render(); fail = true;
    await click(button("Add name")); await input(host.querySelector<HTMLInputElement>("#names-manual-value")!, "Keep this name"); await click(button("Save name")); await advance(450);
    expect(host.textContent).toContain("Not saved · edits kept in this tab"); expect(host.textContent).not.toContain("Saved to your account");
    expect(host.textContent).toContain("Keep this name"); await click(button("Test sign out"));
    expect(host.querySelector("output")!.textContent).toBe("confirmation_required");
    const unloading = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unloading); expect(unloading.defaultPrevented).toBe(true);
    const failedBody = fetcher.mock.calls.find(([, init]) => init?.method === "PUT")![1]!.body;
    fail = false; await click(button("Retry saving")); await advance();
    expect(host.textContent).toContain("Saved to your account"); expect(rows.get(owner)!.payload.candidates[0]!.source.value).toBe("Keep this name");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT").at(-1)![1]!.body).toBe(failedBody);
  });

  it("only imports a legacy browser backup after an explicit account import", async () => {
    const legacy = createEmptyNamesWorkspace(); legacy.candidates.push({ source: { id: "dddddddd-1111-4111-8111-111111111111", value: "Legacy private", origin: "manual", history: [], createdAt: "2026-10-15T12:00:00Z" }, context: contextSnapshotSchema.parse({}), explanation: "Added manually", runId: null, saved: true, favorite: false });
    const raw = JSON.stringify(legacy); localStorage.setItem("fluid.names.v1", raw);
    await render(); expect(rows.size).toBe(0); expect(host.textContent).not.toContain("Legacy private");
    await click(button("Recover earlier browser names")); expect(rows.size).toBe(0);
    await click(button("Import into my account")); await advance(450);
    expect(rows.get(owner)!.payload.candidates[0]!.source.value).toBe("Legacy private"); expect(localStorage.getItem("fluid.names.v1")).toBe(raw);
  });

  it("gates normal Names while signed out", async () => {
    currentOwner = null; await render(); expect(host.querySelector("#names-guided-word")).toBeNull();
    expect(host.textContent).toContain("Sign in to keep your names"); expect(fetcher.mock.calls.some(([path]) => path === "/api/names/workspace")).toBe(false);
  });
});
