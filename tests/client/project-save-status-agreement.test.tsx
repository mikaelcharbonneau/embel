// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountProjectSchema, type AccountProject } from "@/domain/project-api";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { AccountProjectEditor } from "@/components/workspace/account-project-editor";
import { AccountProjectWorkspaceShell } from "@/components/workspace/project-workspace";
import { ProjectHeaderContext, type ProjectHeader } from "@/components/journey/project-header";
import type { AccountGuidedInterview } from "@/components/workspace/account-guided-interview";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const projectId = "bbbbbbbb-2222-4222-8222-222222222222",
  owner = "bbbbbbbb-2222-4222-8222-222222222221";
const account: VerifiedAccount = { status: "ready", userId: owner, generation: 1 };
const mock = vi.hoisted(() => ({
  memory: null as ReturnType<typeof createAccountDraftMemory> | null,
  editor: null as ComponentProps<typeof AccountGuidedInterview> | null,
  // Stable identities: the components list these in effect dependencies.
  isCurrent: (value: { userId: string; generation: number }) =>
    value.userId === "bbbbbbbb-2222-4222-8222-222222222221" && value.generation === 1,
  expire: () => undefined,
  refresh: () => undefined,
}));
vi.mock("next/navigation", () => ({ usePathname: () => `/brands/account/${projectId}` }));
vi.mock("@/components/workspace/account-session", () => ({
  AccountStatus: () => null,
  useAccountSession: () => ({
    session: account,
    drafts: mock.memory,
    isCurrent: mock.isCurrent,
    expire: mock.expire,
    refresh: mock.refresh,
  }),
}));
vi.mock("@/components/workspace/use-project-next-step", () => ({ useProjectNextStep: () => null }));
vi.mock("@/components/workspace/account-project-continuity", () => ({ AccountProjectContinuity: () => null }));
vi.mock("@/components/workspace/account-guided-interview", () => ({
  AccountGuidedInterview: (props: ComponentProps<typeof AccountGuidedInterview>) => {
    mock.editor = props;
    return <div>{props.storage.actions}</div>;
  },
}));

let root: Root | null, host: HTMLDivElement, project: AccountProject, header: ProjectHeader | null;
let patch: (body: { expectedRevision: number; title?: string; context: unknown }) => Response | Promise<Response>;
const publish = (value: ProjectHeader | null) => {
  header = value;
};
async function render(withEditor = true) {
  await act(async () =>
    root!.render(
      <ProjectHeaderContext.Provider value={publish}>
        <AccountProjectWorkspaceShell projectId={projectId}>
          {withEditor ? <AccountProjectEditor projectId={projectId} /> : <p>Another step</p>}
        </AccountProjectWorkspaceShell>
      </ProjectHeaderContext.Provider>,
    ),
  );
}
const edit = (description: string) => act(async () => void mock.editor!.storage.onUpdate({ description }));
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const accepted = (body: { expectedRevision: number; title?: string; context: unknown }) => {
  project = accountProjectSchema.parse({
    ...project,
    current_revision: body.expectedRevision + 1,
    title: body.title ?? project.title,
    context: body.context,
  });
  return Response.json({
    revision: {
      project_id: projectId,
      owner_id: owner,
      revision: project.current_revision,
      context: body.context,
      input_hash: "c".repeat(64),
      created_at: "2026-11-14T00:00:00Z",
    },
  });
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.memory = createAccountDraftMemory();
  mock.editor = null;
  header = null;
  project = accountProjectSchema.parse({
    id: projectId,
    owner_id: owner,
    title: "Save status fixture",
    scope: "complete_brand",
    current_revision: 1,
    created_at: "2026-11-14T00:00:00Z",
    context: { description: "A neighborhood lunch kitchen" },
  });
  patch = accepted;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, init: RequestInit) =>
      init.method === "PATCH" ? patch(JSON.parse(String(init.body))) : Response.json({ project }),
    ),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("says not saved in the bar and on the page after a save fails, and Saved in both after the retry", async () => {
  patch = () => new Response(null, { status: 503 });
  await render();
  expect(header?.saveState).toBe("saved");
  expect(mock.editor!.storage.saveLabel).toBe("Saved");
  await edit("A neighborhood lunch kitchen with a counter");
  await wait(650);
  await wait(0);
  expect(mock.editor!.storage.saveLabel).toBe("Changes not saved");
  expect(header?.saveState).toBe("error");
  // Leaving the conversation keeps the truth: nothing is saving any more.
  await render(false);
  expect(header?.saveState).toBe("error");
  await render();
  expect(header?.saveState).toBe("error");
  patch = accepted;
  await act(async () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Retry save")!.click(),
  );
  await wait(0);
  expect(mock.editor!.storage.saveLabel).toBe("Saved");
  expect(header?.saveState).toBe("saved");
});

it("agrees while an edit waits for its automatic save and while it is being sent", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  patch = async (body) => {
    await held;
    return accepted(body);
  };
  await render();
  await edit("A neighborhood lunch kitchen with a counter");
  expect(mock.editor!.storage.saveLabel).toBe("Saving…");
  expect(header?.saveState).toBe("saving");
  await wait(650);
  expect(mock.editor!.storage.saveLabel).toBe("Saving…");
  expect(header?.saveState).toBe("saving");
  await act(async () => release());
  await wait(0);
  expect(mock.editor!.storage.saveLabel).toBe("Saved");
  expect(header?.saveState).toBe("saved");
});

it("shows no save status, not Not saved, when the latest save could not be checked and nothing is unsaved", async () => {
  const { accountProjectDraft } = await import("@/components/workspace/project-draft-adapter");
  mock.memory!.set({
    generation: 1,
    ownerId: owner,
    saved: project,
    draft: accountProjectDraft(project),
    conflict: false,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  await render(false);
  expect(host.textContent).toContain("We couldn’t check this brand’s latest save. Your work is kept.");
  expect(header?.projectName).toBe("Save status fixture");
  expect(header?.saveState).toBeNull();
});
