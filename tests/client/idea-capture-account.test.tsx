// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdeaDraftMemory } from "@/components/ideas/ideas-draft-memory";
import { IdeasWorkspace } from "@/components/ideas/ideas-workspace";
import { ideaRecordSchema } from "@/domain/ideas";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const fixture = vi.hoisted(() => ({
  session: { status: "ready" as const, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 },
  ideaDrafts: null as unknown as ReturnType<typeof createIdeaDraftMemory>,
  isCurrent: vi.fn(), expire: vi.fn(), push: vi.fn(),
}));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => fixture, AccountStatus: () => <p>Verify account</p> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: fixture.push }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ideaId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", stamp = "2026-10-15T12:00:00.000123Z";
let host: HTMLDivElement, root: Root, cookieOwner: string, requests: RequestInit[];
async function render() { await act(async () => root.render(<IdeasWorkspace />)); }
async function capture(title: string) {
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.startsWith("Add idea"))!.click());
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>(".ideas-capture input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, title);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function save() {
  await act(async () => { host.querySelector(".ideas-capture form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.session = { status: "ready", userId: owner, generation: 1 };
  fixture.ideaDrafts = createIdeaDraftMemory();
  fixture.isCurrent.mockImplementation((account: VerifiedAccount) => fixture.session.userId === account.userId && fixture.session.generation === account.generation);
  fixture.expire.mockReset(); fixture.push.mockReset(); cookieOwner = owner; requests = [];
  vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => {
    if (options.method === "GET") return Response.json({ ownerId: cookieOwner, items: [], nextCursor: null });
    requests.push(options);
    if (new Headers(options.headers).get("X-Embel-Account") !== cookieOwner) return Response.json({}, { status: 401 });
    const input = JSON.parse(String(options.body));
    return Response.json({ idea: ideaRecordSchema.parse({ id: ideaId, ownerId: cookieOwner, revision: 1, content: input.content, links: [], createdAt: stamp, updatedAt: stamp }) });
  }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("idea capture expected account", () => {
  it("sends the verified captured owner and clears the draft only after the account acknowledges creation", async () => {
    await render(); await capture("Owned capture"); await save();
    expect(requests).toHaveLength(1);
    expect(new Headers(requests[0]!.headers).get("X-Embel-Account")).toBe(owner);
    expect(JSON.parse(String(requests[0]!.body))).not.toHaveProperty("ownerId");
    expect(fixture.push).toHaveBeenCalledExactlyOnceWith(`/ideas/${ideaId}`);
    expect(fixture.ideaDrafts.getCapture(owner)).toBeNull(); expect(fixture.expire).not.toHaveBeenCalled();
  });

  it("expires a stale account after a cookie switch and retains its capture without showing it to the other owner", async () => {
    await render(); await capture("Owner A private capture"); cookieOwner = other; await save();
    expect(requests).toHaveLength(1); expect(new Headers(requests[0]!.headers).get("X-Embel-Account")).toBe(owner);
    expect(fixture.expire).toHaveBeenCalledExactlyOnceWith(fixture.session); expect(fixture.push).not.toHaveBeenCalled();
    expect(fixture.ideaDrafts.getCapture(owner)).toMatchObject({ content: { title: "Owner A private capture" }, intent: { content: { title: "Owner A private capture" } } });
    fixture.session = { status: "ready", userId: other, generation: 2 }; await render();
    expect(host.querySelector<HTMLInputElement>(".ideas-capture input")!.value).toBe("");
    expect(fixture.ideaDrafts.getCapture(other)).toBeNull(); expect(requests).toHaveLength(1);
  });
});
