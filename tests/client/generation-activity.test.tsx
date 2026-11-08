// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GenerationActivity } from "@/components/workspace/generation-activity";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const mocks = vi.hoisted(() => ({ request: vi.fn(), expire: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: { status: "ready", userId: owner, generation: 1 }, isCurrent: () => true, expire: mocks.expire }) }));
vi.mock("@/components/workspace/account-api", () => ({ accountRequest: mocks.request, AccountRequestError: class extends Error {} }));

const job = (id: string, state: string, operation = "naming.generate") => ({ id, ownerId: owner, projectId: project, projectTitle: "Launchpad", operation, state, progress: 40, createdAt: "2026-11-07T10:00:00Z", finishedAt: null });
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
  mocks.request.mockReset().mockResolvedValue({ ownerId: owner, active: [job("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "needs_reconciliation")], recent: [job("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "succeeded", "strategy.competitors")] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function open() {
  await act(async () => root.render(<GenerationActivity />));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Activity"]')!.click());
  return host.querySelector("dialog")!;
}

it("links each row to its project and explains an unconfirmed result with a way forward", async () => {
  const dialog = await open();
  const rows = [...dialog.querySelectorAll<HTMLAnchorElement>("a.generation-activity-row")];
  expect(rows.map(row => [row.textContent, row.getAttribute("href")])).toEqual([["LaunchpadNaming", `/brands/account/${project}/naming`], ["LaunchpadCompetitors", `/brands/account/${project}?view=strategy`]]);
  expect(dialog.textContent).toContain("Not confirmed"); expect(dialog.textContent).toContain("Done");
  const recovery = dialog.querySelector<HTMLAnchorElement>(".generation-activity-inline-link")!;
  expect(recovery.parentElement?.textContent).toBe("We couldn’t confirm this result. Open the project to continue.");
  expect(recovery.getAttribute("href")).toBe(`/brands/account/${project}/naming`);
  expect(dialog.textContent).not.toMatch(/needs review|will not be retried|Close activity/i);
});

it("closes from a standard icon button named Close and on Escape", async () => {
  let dialog = await open();
  const buttons = [...dialog.querySelectorAll("button")];
  expect(buttons).toHaveLength(1); expect(buttons[0]!.getAttribute("aria-label")).toBe("Close"); expect(buttons[0]!.textContent).toBe("");
  await act(async () => buttons[0]!.click()); expect(dialog.open).toBe(false);
  dialog = await open(); expect(dialog.open).toBe(true);
  await act(async () => { dialog.dispatchEvent(new Event("cancel", { cancelable: true })); });
  expect(dialog.open).toBe(false);
});
