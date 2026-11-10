// @vitest-environment jsdom
import { installDialogMethods } from "../helpers/dialog-methods";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSessionProvider, useAccountSession } from "@/components/workspace/account-session";
import { AccountProjectEditor } from "@/components/workspace/account-project-editor";
import { accountProjectSchema, type AccountProject } from "@/domain/project-api";

vi.mock("@/components/workspace/account-project-continuity", () => ({ AccountProjectContinuity: () => null }));
vi.mock("@/components/workspace/use-strategy-jobs", () => ({
  useStrategyJobs: () => ({
    overview: { jobs: [], availability: { status: "unavailable", operations: [], reason: "worker_unavailable" } },
    pending: false,
    readError: null,
    actionError: null,
    refresh: vi.fn(),
    enqueue: vi.fn(),
    cancel: vi.fn(),
  }),
}));

const owner = "aaaaaaaa-2222-4222-8222-111111111111",
  projectId = "bbbbbbbb-2222-4222-8222-111111111111";
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let root: Root, host: HTMLDivElement, account: ReturnType<typeof useAccountSession>, project: AccountProject;
let patch: ReturnType<typeof deferred<Response>>, sessionRead: () => Promise<Response>, bodies: string[];
function Probe() {
  const value = useAccountSession();
  useLayoutEffect(() => {
    account = value;
  });
  return null;
}
async function mount() {
  await act(async () =>
    root.render(
      <AccountSessionProvider>
        <Probe />
        <AccountProjectEditor projectId={projectId} />
        <button type="button" data-outside>
          Another control
        </button>
      </AccountSessionProvider>,
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(account.session.status).toBe("ready");
  await act(async () =>
    host.querySelector<HTMLButtonElement>('.guided-brief-editor > button[aria-haspopup="dialog"]')!.click(),
  );
}
function field(label: string) {
  return [...host.querySelectorAll("label")]
    .find((node) => node.textContent?.startsWith(label))!
    .querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")!;
}
async function edit(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    input.focus();
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function startSave() {
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(bodies).toHaveLength(1);
}
async function acknowledge() {
  const body = JSON.parse(bodies[0]!);
  project = {
    ...project,
    title: body.title ?? project.title,
    context: body.context,
    current_revision: body.expectedRevision + 1,
  };
  await act(async () =>
    patch.resolve(
      Response.json({
        revision: {
          project_id: projectId,
          owner_id: owner,
          revision: project.current_revision,
          context: body.context,
          input_hash: "a".repeat(64),
          created_at: "2026-10-20T00:00:00Z",
        },
      }),
    ),
  );
}
let restoreDialogs: () => void;
beforeEach(() => {
  restoreDialogs = installDialogMethods();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  bodies = [];
  patch = deferred<Response>();
  project = accountProjectSchema.parse({
    id: projectId,
    owner_id: owner,
    scope: "complete_brand",
    title: "Focus fixture",
    current_revision: 1,
    created_at: "2026-10-20T00:00:00Z",
    context: { description: "A synthetic neighborhood lunch kitchen" },
  });
  sessionRead = async () => Response.json({ user: { id: owner } });
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, init: RequestInit) => {
      if (path === "/api/session") return sessionRead();
      expect(path).toBe(`/api/projects/${projectId}`);
      if (init.method === "GET") return Promise.resolve(Response.json({ project }));
      expect(init.method).toBe("PATCH");
      bodies.push(String(init.body));
      return patch.promise;
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  restoreDialogs();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("focus-preserving account draft locks", () => {
  it.each([
    "Project label",
    "Brief description",
    "What the business does",
    "First products / services",
    "Known audience",
  ])("keeps %s mounted and focusable but read-only through an acknowledged autosave", async (label) => {
    await mount();
    const input = field(label),
      generation = account.session.generation,
      value = `Saved draft for ${label}`;
    await edit(input, value);
    input.setSelectionRange(2, 6);
    await startSave();
    expect(field(label)).toBe(input);
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(true);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
    const pending = account.drafts.get(projectId)!.pendingDraftSave;
    expect(pending).toBeDefined();
    expect(JSON.stringify(pending!.body)).toBe(bodies[0]);
    await acknowledge();
    expect(field(label)).toBe(input);
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(false);
    expect(input.value).toBe(value);
    expect(document.activeElement).toBe(input);
    expect(account.session.generation).toBe(generation);
    expect(account.drafts.get(projectId)!.pendingDraftSave).toBeUndefined();
    expect(bodies).toHaveLength(1);
  });

  it("does not refocus the field if the user moves to another control before the save settles", async () => {
    await mount();
    await edit(field("Project label"), "A focused draft");
    await startSave();
    const outside = host.querySelector<HTMLButtonElement>("[data-outside]")!;
    outside.focus();
    await acknowledge();
    expect(document.activeElement).toBe(outside);
    expect(bodies).toHaveLength(1);
  });

  it("keeps an uncertain save frozen without losing the field or automatically repeating the write", async () => {
    await mount();
    const input = field("Project label");
    await edit(input, "An unconfirmed draft");
    await startSave();
    const original = account.drafts.get(projectId)!.pendingDraftSave;
    await act(async () => patch.resolve(new Response(null, { status: 503 })));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(field("Project label")).toBe(input);
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe("An unconfirmed draft");
    expect(account.drafts.get(projectId)!.pendingDraftSave).toBe(original);
    expect(host.textContent).toContain("Retry save");
    expect(bodies).toHaveLength(1);
  });

  it("still hides private editing immediately on verification and rejects the late save reply", async () => {
    await mount();
    await edit(field("Project label"), "Private pending draft");
    await startSave();
    const recheck = deferred<Response>();
    sessionRead = () => recheck.promise;
    // Explicit verification fences private content; ordinary tab focus deliberately does not.
    await act(async () => account.refresh());
    expect(account.session.status).toBe("checking");
    expect(host.querySelector(".guided-brief-editor")).toBeNull();
    await acknowledge();
    expect(host.querySelector(".guided-brief-editor")).toBeNull();
    expect(host.textContent).not.toContain("Private pending draft");
    await act(async () => recheck.resolve(new Response(null, { status: 401 })));
    expect(account.session.status).toBe("signed_out");
    expect(bodies).toHaveLength(1);
  });
});
