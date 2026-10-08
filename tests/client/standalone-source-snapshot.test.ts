// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FrozenStandaloneSource } from "@/features/brand-lifecycle/frozen-source";
import { createTrademarkDraft } from "@/features/trademark-workspace/domain";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { StandalonePromotionSource } from "@/domain/standalone-promotion";
const session = vi.hoisted(() => ({ current: vi.fn(() => true), expire: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ isCurrent: session.current, expire: session.expire }) }));
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", workspace = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", sourceId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const account: VerifiedAccount = { status: "ready", userId: owner, generation: 1 };
const source: StandalonePromotionSource = { id: sourceId, ownerId: owner, workspaceId: workspace, workspaceRevision: 3, selection: { tool: "domains", domain: "cedar.com" }, payloadHash: "a".repeat(64), contextSource: null, createdAt: "2026-10-07T00:00:00Z" };
const domainResponse = () => ({ ownerId: owner, projectId, source, snapshot: { workspaceId: workspace, workspaceRevision: 3, payload: { tool: "domains", data: { version: 1, input: "cedar", extensions: ["com"], candidates: ["cedar.com"] } } } });
let root: Root | null = null;
async function mount(origin = source) { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); const host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root!.render(createElement(FrozenStandaloneSource, { account, projectId, source: origin }))); return host; }
async function inspect(host: HTMLElement) { await act(async () => host.querySelector<HTMLButtonElement>("button")!.click()); }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); session.current.mockReturnValue(true); });
describe("frozen manual standalone input inspection", () => {
 it("loads the exact saved source only when requested and never implies domain availability", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(domainResponse())); vi.stubGlobal("fetch", fetcher);
  const host = await mount(); expect(fetcher).not.toHaveBeenCalled(); await inspect(host);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/projects/${projectId}/standalone-source/snapshot`, expect.objectContaining({ method: "GET", cache: "no-store" }));
  expect(host.textContent).toContain("Frozen domains version 3"); expect(host.textContent).toContain("cedar.com"); expect(host.textContent).toContain("Availability was not checked");
 });
 it("rejects a substituted saved revision instead of displaying current workspace content", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...domainResponse(), snapshot: { ...domainResponse().snapshot, workspaceRevision: 4 } })));
  const host = await mount(); await inspect(host); expect(host.textContent).toContain("could not be verified"); expect(host.querySelector('[aria-label="Frozen input details"]')).toBeNull();
 });
 it("shows preserved trademark notes and manual review limits without claiming clearance", async () => {
  const origin = { ...source, selection: { tool: "trademarks" as const } };
  const draft = { ...createTrademarkDraft("Saved Cedar mark"), owner: { name: "Owner fixture", address: "Private fixture address", contact: "owner@example.invalid" }, representationNotes: "Original logo notes", territories: ["User territory"], goodsServices: "Original goods", classificationNotes: "Unvalidated classification", userNotes: "Original caveat" };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ownerId: owner, projectId, source: origin, snapshot: { workspaceId: workspace, workspaceRevision: 3, payload: { tool: "trademarks", data: draft } } })));
  const host = await mount(origin); await inspect(host);
  expect(host.textContent).toContain("Original caveat"); expect(host.textContent).toContain("Original logo notes"); expect(host.textContent).toContain("Private fixture address"); expect(host.textContent).toContain("does not establish clearance");
 });
 it("shows the exact selected handle bundle as declarations without platform verification", async () => {
  const origin = { ...source, selection: { tool: "handles" as const, bundleId: "saved-bundle" } };
  const data = { version: 1, bundles: [{ id: "saved-bundle", title: "Original handles", list: "Saved user list", savedAt: "2026-10-07T00:00:00Z", source: { id: "manual", name: "User source label", origin: "manual", projectId: null, projectTitle: null }, entries: [{ platform: "instagram", handle: "cedar", favorite: true, selected: true, evidence: [], accountCreated: { declaredAt: "2026-10-07T00:00:00Z", url: "https://instagram.com/cedar" } }] }] };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ownerId: owner, projectId, source: origin, snapshot: { workspaceId: workspace, workspaceRevision: 3, payload: { tool: "handles", data } } })));
  const host = await mount(origin); await inspect(host);
  expect(host.textContent).toContain("Original handles"); expect(host.textContent).toContain("Instagram: @cedar"); expect(host.textContent).toContain("Account creation declared by you"); expect(host.textContent).toContain("No platform verification"); expect(host.textContent).not.toContain("Confirmed available");
 });
 it("fences a delayed private snapshot when the verified owner changes", async () => {
  let finish!: (response: Response) => void; vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const host = await mount(); await inspect(host); session.current.mockReturnValue(false);
  await act(async () => { root!.render(createElement(FrozenStandaloneSource, { account, projectId, source })); finish(Response.json(domainResponse())); });
  expect(host.textContent).not.toContain("cedar.com"); expect(host.querySelector('[aria-label="Frozen input details"]')).toBeNull();
 });
});
