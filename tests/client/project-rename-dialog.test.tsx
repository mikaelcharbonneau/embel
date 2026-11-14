// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectCardActions } from "@/components/workspace/project-card-actions";
import type { LifecycleProject } from "@/components/workspace/project-deletion-client";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { ToastProvider } from "@/components/ui/toast";

const mock = vi.hoisted(() => ({
  session: null as VerifiedAccount | null,
  current: vi.fn(),
  expire: vi.fn(),
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({ session: mock.session, isCurrent: mock.current, expire: mock.expire }),
}));

// Synthetic responses only; no account connection.
const owner = "aaaaaaaa-3333-4333-8333-333333333333";
const listed: LifecycleProject = {
  id: "cccccccc-3333-4333-8333-333333333333",
  owner_id: owner,
  title: "Persimmon",
  scope: "complete_brand",
  current_revision: 3,
  lifecycle_version: 1,
  deleted_at: null,
  deletion_requested_at: null,
  deletion_state: "active",
  created_at: "2026-10-10T12:00:00Z",
};
const saved = (revision: number, context: Record<string, unknown> = {}) => ({
  project: {
    ...listed,
    current_revision: revision,
    context: { description: "Fresh fruit boxes", selectedName: "Persimmon", ...context },
  },
});
const revision = (number: number, context: Record<string, unknown>) => ({
  revision: {
    project_id: listed.id,
    owner_id: owner,
    revision: number,
    context: { description: "Fresh fruit boxes", selectedName: "Persimmon", ...context },
    input_hash: "hash",
    created_at: "2026-11-14T12:00:00Z",
  },
});

let host: HTMLDivElement,
  root: Root,
  fetcher: ReturnType<typeof vi.fn<(path: string, init: RequestInit) => Promise<Response>>>,
  renamed: ReturnType<typeof vi.fn<(name: string, revision: number) => void>>;
let replies: Array<() => Response | Promise<Response>>;
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  )!;
const field = () => host.querySelector<HTMLInputElement>("dialog input")!;
const requests = () =>
  fetcher.mock.calls.map(([path, init]) => ({
    path,
    method: init.method,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  }));
async function click(label: string) {
  await act(async () => button(label).click());
}
async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field(), value);
    field().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render() {
  await act(async () =>
    root.render(
      <ToastProvider>
        <article>
          <ProjectCardActions
            project={listed}
            account={mock.session!}
            name="Persimmon"
            onChanged={vi.fn()}
            onReload={vi.fn(async () => true)}
            onRenamed={renamed}
          />
        </article>
      </ToastProvider>,
    ),
  );
}
async function openRename() {
  await click("Project options for Persimmon");
  await click("Rename");
}
async function flush() {
  for (let index = 0; index < 6; index += 1) await act(async () => undefined);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.session = { status: "ready", userId: owner, generation: 1 };
  mock.current
    .mockReset()
    .mockImplementation(
      (account: VerifiedAccount) => account.userId === mock.session?.userId && account.generation === 1,
    );
  mock.expire.mockReset();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  replies = [];
  fetcher = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(async () => {
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected request");
    return reply();
  });
  vi.stubGlobal("fetch", fetcher);
  renamed = vi.fn<(name: string, revision: number) => void>();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("renaming a project from its card", () => {
  it("offers Rename before Delete, with Delete last after a separator", async () => {
    await render();
    await click("Project options for Persimmon");
    const rows = [...host.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="separator"]')];
    expect(rows.map((row) => row.getAttribute("role") === "separator" || row.textContent)).toEqual([
      "Rename",
      true,
      "Delete",
    ]);
  });

  it("opens a small dialog with the current name ready to edit", async () => {
    await render();
    await openRename();
    const dialog = host.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain("Rename project");
    expect(dialog.textContent).toContain(
      "This changes the name on your cards and project bar. Your brand name and brand kit stay the same.",
    );
    expect(dialog.querySelector("label")?.textContent).toBe("Project name");
    expect(field().value).toBe("Persimmon");
    expect(document.activeElement).toBe(field());
    expect(button("Save name")).toBeTruthy();
    await click("Cancel");
    expect(host.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(button("Project options for Persimmon"));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("asks for a name instead of saving an empty one", async () => {
    await render();
    await openRename();
    await type("   ");
    await click("Save name");
    expect(host.querySelector("dialog")?.textContent).toContain("Enter a name.");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field());
    expect(fetcher).not.toHaveBeenCalled();
    await type("Spring");
    expect(host.querySelector("dialog")?.textContent).not.toContain("Enter a name.");
  });

  it("saves the name on the latest revision, keeps the brand name, confirms and returns focus", async () => {
    replies.push(
      () => Response.json(saved(5)),
      () => Response.json(revision(6, { displayName: "Spring launch" })),
    );
    await render();
    await openRename();
    await type("  Spring launch ");
    await click("Save name");
    await flush();
    expect(requests()).toEqual([
      { path: `/api/projects/${listed.id}`, method: "GET", body: undefined },
      {
        path: `/api/projects/${listed.id}`,
        method: "PATCH",
        body: {
          expectedRevision: 5,
          context: expect.objectContaining({ selectedName: "Persimmon", displayName: "Spring launch" }),
        },
      },
    ]);
    expect(renamed).toHaveBeenCalledExactlyOnceWith("Spring launch", 6);
    expect(host.querySelector("dialog")).toBeNull();
    expect(document.body.textContent).toContain("Project renamed");
    expect(document.activeElement).toBe(button("Project options for Persimmon"));
  });

  it("reloads a project that changed meanwhile, says so in the dialog and saves on Try again", async () => {
    replies.push(
      () => Response.json(saved(3)),
      () => new Response(null, { status: 409 }),
      () => Response.json(saved(4, { positioning: "Fruit for offices" })),
      () => Response.json(revision(5, { positioning: "Fruit for offices", displayName: "Spring launch" })),
    );
    await render();
    await openRename();
    await type("Spring launch");
    await click("Save name");
    await flush();
    const dialog = host.querySelector("dialog")!;
    expect(dialog.textContent).toContain("This project changed while you were renaming it.");
    expect(dialog.textContent).toContain("Its latest version has been loaded.");
    expect(field().value).toBe("Spring launch");
    expect(renamed).not.toHaveBeenCalled();
    await click("Try again");
    await flush();
    const patches = requests().filter((request) => request.method === "PATCH");
    expect(patches.map((request) => request.body.expectedRevision)).toEqual([3, 4]);
    expect(patches[1]!.body.context).toMatchObject({ positioning: "Fruit for offices", displayName: "Spring launch" });
    expect(renamed).toHaveBeenCalledExactlyOnceWith("Spring launch", 5);
    expect(host.querySelector("dialog")).toBeNull();
    expect(document.body.textContent).toContain("Project renamed");
  });

  it("checks the project after a lost reply and does not save the same name twice", async () => {
    replies.push(
      () => Response.json(saved(3)),
      () => new Response(null, { status: 503 }),
      () => Response.json(saved(4, { displayName: "Spring launch" })),
    );
    await render();
    await openRename();
    await type("Spring launch");
    await click("Save name");
    await flush();
    expect(requests().filter((request) => request.method === "PATCH")).toHaveLength(1);
    expect(renamed).toHaveBeenCalledExactlyOnceWith("Spring launch", 4);
    expect(document.body.textContent).toContain("Project renamed");
  });

  it("keeps the dialog open with a retry when the name could not be saved", async () => {
    replies.push(
      () => Response.json(saved(3)),
      () => new Response(null, { status: 503 }),
      () => Response.json(saved(3)),
    );
    await render();
    await openRename();
    await type("Spring launch");
    await click("Save name");
    await flush();
    expect(host.querySelector("dialog")?.textContent).toContain("The name couldn’t be saved.");
    expect(button("Try again")).toBeTruthy();
    expect(renamed).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Project renamed");
  });
});
