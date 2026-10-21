// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { contextSnapshotSchema } from "@/domain/projects";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { useAccountStrategyStart } from "@/components/workspace/account-strategy-start";
import { readGuidedStartConsent } from "@/components/workspace/guided-start-consent";
const mocks = vi.hoisted(() => ({ push: vi.fn(), expire: vi.fn(), save: vi.fn(), current: vi.fn(() => true) }));
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const account = { status: "ready" as const, userId: owner, generation: 1 };
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: account, isCurrent: mocks.current, expire: mocks.expire, refresh: vi.fn() }) }));
vi.mock("@/components/workspace/save-local-draft-to-account", () => ({ saveLocalDraftToAccount: (...args: unknown[]) => mocks.save(...args), finishLocalDraftRecovery: vi.fn() }));
vi.mock("@/components/workspace/prompt-recovery", () => ({ rememberPromptForSignIn: vi.fn() }));
let root: Root, host: HTMLDivElement, api: ReturnType<typeof useAccountStrategyStart>, fetcher: ReturnType<typeof vi.fn<(path: string, init?: RequestInit) => Promise<Response>>>;
const project = () => ({ id: projectId, owner_id: owner, current_revision: 1, created_at: "2026-10-21T00:00:00Z", scope: "complete_brand" as const, title: "Admission fixture", context: contextSnapshotSchema.parse({ description: "A synthetic neighborhood bakery" }) });
function Harness() { const value = useAccountStrategyStart({ guided: true }); useLayoutEffect(() => { api = value; }); return createElement("div", null, value.notice); }
const available = { status: "available", operations: [{ operation: "strategy.competitors", maximumCostMicrousd: 10000, interviewVersion: 1 }] };
beforeEach(() => {
 vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.localStorage.clear(); window.sessionStorage.clear(); mocks.push.mockReset(); mocks.expire.mockReset(); mocks.current.mockReturnValue(true);
 mocks.save.mockReset().mockResolvedValue({ project: project(), receipt: { ownerId: owner, draftId: projectId, projectId } });
 fetcher = vi.fn(async (path: string, init?: RequestInit) => {
  if (path === "/api/strategy") return Response.json({ availability: { status: "unavailable", operations: [], reason: "request_unresolved" } });
  if (path === `/api/projects/${projectId}/strategy`) return Response.json({ availability: available, jobs: [] });
  if (path === `/api/projects/${projectId}` && init?.method === "PATCH") return Response.json({ revision: { project_id: projectId, owner_id: owner, revision: 2, context: JSON.parse(String(init.body)).context, input_hash: "a".repeat(64), created_at: "2026-10-21T00:00:00Z" } });
  throw new Error("unexpected_request");
 }); vi.stubGlobal("fetch", fetcher); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function start() { await act(async () => root.render(createElement(Harness))); await act(async () => { await api.start(accountProjectDraft(project())); }); }
it("checks the saved project when the account-level check is blocked and retains one exact research intent", async () => {
 await start();
 const patch = fetcher.mock.calls.find(([,init]) => init?.method === "PATCH")!;
 expect(patch).toBeDefined();
 const body = JSON.parse(String(patch[1]!.body));
 expect(body.expectedRevision).toBe(1);
 const turn = body.context.intake.guidedInterview.turns[0];
 expect(turn.inputRevision).toBe(2);
 expect(readGuidedStartConsent(owner, turn.id)).toMatchObject({ projectId, inputRevision: 2, attempted: false });
 expect(mocks.push).toHaveBeenCalledOnce();
 expect(fetcher.mock.calls.filter(([,init]) => init?.method === "POST")).toHaveLength(0);
});
it("does not create a research intent when the scoped worker is unavailable", async () => {
 fetcher.mockImplementation(async () => Response.json({ availability: { status: "unavailable", operations: [], reason: "worker_unavailable" }, jobs: [] }));
 await start(); expect(fetcher.mock.calls.some(([,init]) => init?.method === "PATCH")).toBe(false); expect(mocks.push).toHaveBeenCalledOnce();
});
it("never uses another owner's project", async () => {
 mocks.save.mockResolvedValue({ project: { ...project(), owner_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, receipt: { ownerId: owner, draftId: projectId, projectId } });
 await start(); expect(mocks.expire).toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled(); expect(fetcher.mock.calls.some(([,init]) => init?.method === "PATCH")).toBe(false);
});
it("does not bind automatic admission when the intent write acknowledgement is lost", async () => {
 const original = fetcher.getMockImplementation()!;
 fetcher.mockImplementation(async (path, init) => { if (init?.method === "PATCH") throw new Error("synthetic_ack_lost"); return original(path, init); });
 await start(); expect(readGuidedStartConsent(owner, `guided-start-v1:${projectId}`)?.projectId).toBeNull(); expect(mocks.push).not.toHaveBeenCalled();
});
