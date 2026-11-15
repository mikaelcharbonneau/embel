// @vitest-environment jsdom
import { sessionStandIn } from "./session-stand-in";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { clearLocalDrafts, createLocalDraft } from "@/components/workspace/local-drafts";
import { NewProjectForm } from "@/components/workspace/project-editor";
import { createHomeInputSession, type HomeInputSession } from "@/features/home-inputs/home-input-session";

// On the Home prompt a control that would do nothing is disabled (docs/state-machines.md, J7).
const mock = vi.hoisted(() => ({
  session: { status: "signed_out", generation: 1 } as
    VerifiedAccount | { status: "checking" | "signed_out"; generation: number },
  memory: null as HomeInputSession | null,
  push: vi.fn(),
  current: vi.fn(),
  expire: vi.fn(),
  refresh: vi.fn(),
}));
let accountDrafts: ReturnType<typeof createAccountDraftMemory>;
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () =>
    sessionStandIn({
      drafts: accountDrafts,
      session: mock.session,
      homeInputSession: mock.memory,
      isCurrent: mock.current,
      expire: mock.expire,
      refresh: mock.refresh,
    }),
}));

let root: Root, host: HTMLDivElement, owner: string, fetcher: ReturnType<typeof vi.fn>;
const render = (exampleId?: string) =>
  act(async () => root.render(createElement(NewProjectForm, { home: true, exampleId })));
const send = () => host.querySelector<HTMLButtonElement>(".home-composer button[type='submit']")!;
const field = () => host.querySelector<HTMLTextAreaElement>(".home-composer textarea")!;
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(label));

beforeEach(() => {
  accountDrafts = createAccountDraftMemory();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollTo = vi.fn();
  window.sessionStorage.clear();
  window.localStorage.clear();
  clearLocalDrafts();
  owner = crypto.randomUUID();
  mock.memory = createHomeInputSession();
  mock.push.mockReset();
  mock.current.mockImplementation(
    (account: VerifiedAccount) =>
      mock.session.status === "ready" &&
      account.userId === mock.session.userId &&
      account.generation === mock.session.generation,
  );
  fetcher = vi.fn(async (path: string) => {
    if (path.endsWith("/capability")) return Response.json({ ownerId: owner, policy: null, reason: "No storage" });
    if (path === "/api/strategy")
      return Response.json({
        availability: { status: "unavailable", operations: [], reason: "worker_unavailable" },
      });
    // The save's answer never arrives.
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("Home prompt controls that would do nothing", () => {
  it("disables Send for a prompt that belongs to another account, and offers a new prompt", async () => {
    mock.session = { status: "ready", userId: owner, generation: 1 };
    mock.memory!.bind(mock.session);
    await render("b2b");
    expect(send().disabled).toBe(false);
    await act(async () => send().click());
    // The account signs out while its prompt is being saved: the prompt is hidden, not handed over.
    mock.session = { status: "signed_out", generation: 2 };
    mock.memory!.bind(null);
    await render("b2b");
    expect(host.textContent).toContain("An unsaved prompt belongs to another account session.");
    expect(field().value).toBe("");
    expect(field().readOnly).toBe(true);
    expect(send().disabled).toBe(true);
    const posts = fetcher.mock.calls.length;
    await act(async () => send().click());
    expect(fetcher.mock.calls).toHaveLength(posts);
    expect(mock.push).not.toHaveBeenCalled();
    // The way forward the screen already shows.
    await act(async () => button("Start a new prompt")!.click());
    expect(host.textContent).not.toContain("An unsaved prompt belongs to another account session.");
    expect(field().readOnly).toBe(false);
  });

  it("holds the prompt, not only Send, when nobody is signed in and the device has no room to keep it", async () => {
    for (let index = 0; index < 50; index += 1)
      createLocalDraft({
        title: `Kept ${index}`,
        scope: "complete_brand",
        description: `Unsaved project ${index}`,
        suppliedName: "",
        namingNotes: "",
        identityNotes: "",
        example: false,
      });
    mock.session = { status: "signed_out", generation: 1 };
    mock.memory!.bind(null);
    await render();
    expect(host.textContent).toContain("This device has 50 unsaved projects.");
    expect(host.querySelector('a[href="/brands?recover=1"]')).not.toBeNull();
    expect(send().disabled).toBe(true);
    expect(field().readOnly).toBe(true);
    expect(button("A skincare studio")!.disabled).toBe(true);
  });
});
