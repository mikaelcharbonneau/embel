// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GenerationActivity } from "@/components/workspace/generation-activity";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  project = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
// The provider's session object and callbacks are stable between renders, as useCallback makes them in the app.
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  expire: vi.fn(),
  isCurrent: () => true,
  session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 },
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({ session: mocks.session, isCurrent: mocks.isCurrent, expire: mocks.expire }),
}));
vi.mock("@/components/workspace/account-api", () => ({
  accountRequest: mocks.request,
  AccountRequestError: class extends Error {},
}));

let serial = 0;
const job = (
  state: string,
  operation = "naming.generate",
  createdAt = "2026-11-07T10:00:00Z",
  projectId = project,
  projectTitle = "Launchpad",
) => ({
  id: `dddddddd-dddd-4ddd-8ddd-${String(++serial).padStart(12, "0")}`,
  ownerId: owner,
  projectId,
  projectTitle,
  operation,
  state,
  progress: 40,
  createdAt,
  finishedAt: ["succeeded", "failed", "partial", "cancelled"].includes(state) ? createdAt : null,
});
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  mocks.request.mockReset().mockResolvedValue({
    ownerId: owner,
    active: [job("needs_reconciliation")],
    recent: [job("succeeded", "strategy.competitors")],
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function open() {
  await act(async () => root.render(<GenerationActivity />));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Activity"]')!.click());
  return host.querySelector("dialog")!;
}
const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, " ").trim();
const sections = (dialog: HTMLDialogElement) =>
  [...dialog.querySelectorAll("section")].map((section) => ({
    heading: text(section.querySelector("h3")),
    rows: [...section.querySelectorAll("li")].map((row) => text(row.querySelector("a"))),
  }));

it("is titled Activity and links each action to its project step", async () => {
  const dialog = await open();
  expect(text(dialog.querySelector("h2"))).toBe("Activity");
  expect(dialog.textContent).not.toContain("Generation activity");
  const links = [...dialog.querySelectorAll<HTMLAnchorElement>("a")];
  expect(links.map((link) => [text(link), link.getAttribute("href")])).toEqual([
    ["Launchpad · Names", `/brands/account/${project}/naming`],
    ["Launchpad · Competitors", `/brands/account/${project}?view=strategy`],
  ]);
  expect(dialog.textContent).toContain("Not confirmed");
  expect(dialog.textContent).toContain("We couldn’t confirm this result. Open the project to continue.");
  expect(dialog.textContent).toContain("This is your latest activity. Open a project to see everything made for it.");
});

it("shows one row per click, running and failed first, with a true summary", async () => {
  mocks.request.mockResolvedValue({
    ownerId: owner,
    active: [job("running", "identity.logo_refine", "2026-11-07T11:00:00Z", other, "Kestrel Analytics")],
    recent: [
      ...Array.from({ length: 6 }, (_, index) =>
        job("succeeded", "identity.logo_concept", `2026-11-07T10:00:0${index}Z`),
      ),
      job("failed", "identity.image", "2026-11-07T10:30:00Z", other, "Kestrel Analytics"),
      job("failed", "identity.image", "2026-11-07T10:30:01Z", other, "Kestrel Analytics"),
      job("succeeded", "identity.image", "2026-11-07T10:30:02Z", other, "Kestrel Analytics"),
    ],
  });
  const dialog = await open();
  expect(text(dialog.querySelector("p"))).toBe("One thing is running and one failed.");
  expect(sections(dialog)).toEqual([
    {
      heading: "Running and failed",
      rows: ["Kestrel Analytics · Logo change", "Kestrel Analytics · Three creative directions"],
    },
    { heading: "Done", rows: ["Launchpad · Six logo concepts"] },
  ]);
  const rows = [...dialog.querySelectorAll("li")];
  expect(rows[0]!.querySelector(".e-spinner")).not.toBeNull();
  expect(rows[0]!.textContent).toContain("Running");
  expect(rows[1]!.querySelector(".e-badge--danger [data-icon='circle-alert']")).not.toBeNull();
  expect(rows[1]!.textContent).toContain("Some couldn’t be made");
  expect(rows[2]!.querySelector("[data-icon='check']")).not.toBeNull();
  expect(rows[2]!.textContent).toContain("Done");
  expect(dialog.textContent).not.toMatch(/\$|cost|credit/i);
});

it("closes when a row title is followed", async () => {
  const dialog = await open();
  await act(async () => dialog.querySelector<HTMLAnchorElement>("a")!.click());
  expect(host.querySelector("dialog")).toBeNull();
});

it("shows skeleton rows while loading and an empty state when nothing has run", async () => {
  let resolve!: (value: unknown) => void;
  mocks.request.mockReturnValue(new Promise((done) => (resolve = done)));
  const dialog = await open();
  const loading = dialog.querySelector('[role="status"]')!;
  expect(loading.getAttribute("aria-label")).toBe("Loading your activity");
  expect(loading.querySelectorAll(".e-skeleton").length).toBeGreaterThan(4);
  await act(async () => resolve({ ownerId: owner, active: [], recent: [] }));
  expect(text(dialog.querySelector("h3"))).toBe("Nothing has run yet");
  expect(dialog.querySelector("[data-icon='clock']")).not.toBeNull();
  expect(dialog.textContent).toContain(
    "When Embel is making names, logos or images for you, you can follow them here.",
  );
  expect(dialog.querySelector('[role="status"]')).toBeNull();
});

it("explains a failed load with a danger message and recovers on Try again", async () => {
  mocks.request.mockRejectedValueOnce(new Error("offline"));
  const dialog = await open();
  const alert = dialog.querySelector('[role="alert"]')!;
  expect(alert.classList.contains("e-message--danger")).toBe(true);
  expect(alert.textContent).toContain("Your activity couldn’t be loaded. Check your connection, then try again.");
  expect(dialog.querySelector("a")).toBeNull();
  const retry = [...alert.querySelectorAll("button")].find((button) => text(button) === "Try again")!;
  expect(retry.className).toContain("e-button--secondary");
  await act(async () => retry.click());
  expect(dialog.querySelector('[role="alert"]')).toBeNull();
  expect(dialog.querySelectorAll("a")).toHaveLength(2);
});

it("closes from a standard icon button named Close and on Escape", async () => {
  let dialog = await open();
  const buttons = [...dialog.querySelectorAll("button")];
  expect(buttons).toHaveLength(1);
  expect(buttons[0]!.getAttribute("aria-label")).toBe("Close");
  expect(buttons[0]!.textContent).toBe("");
  await act(async () => buttons[0]!.click());
  expect(dialog.open).toBe(false);
  expect(host.querySelector("dialog")).toBeNull();
  dialog = await open();
  expect(dialog.open).toBe(true);
  await act(async () => {
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  });
  expect(dialog.open).toBe(false);
  expect(host.querySelector("dialog")).toBeNull();
});
