// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ideaContentSchema } from "@/domain/ideas";
import { createLifecycleIntentMemory } from "@/features/brand-lifecycle/intent-memory";
import { createAccountLifecycleClient } from "@/components/workspace/account-lifecycle-client";
import type { AttachIdeaToProjectInput, IdeaProjectAttachmentOutcome } from "@/domain/idea-project-attachment";
import type { VerifiedAccount } from "@/components/workspace/account-session";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const key = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", project = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const account: VerifiedAccount = { status: "ready", userId: owner, generation: 1 };
const input = { requestKey: key, ideaId: key, expectedIdeaRevision: 2, projectId: project, expectedProjectRevision: 4 };
const receipt = () => ({ ownerId: owner, requestKey: key, association: { id: key, ideaId: key, ideaRevision: 2, projectId: project, projectRevision: 4, createdAt: "2026-10-07T00:00:00Z" }, source: { content: ideaContentSchema.parse({ title: "Frozen Idea", description: "Version two" }) } });
const outcome = (attempt: AttachIdeaToProjectInput = input, status: "attached" | "already_attached" = "attached"): IdeaProjectAttachmentOutcome => ({ ownerId: owner, requestKey: attempt.requestKey, status, input: attempt, attachment: status === "attached" ? { ...receipt(), requestKey: attempt.requestKey } : receipt() });
describe("Idea association ownership and recovery", () => {
 afterEach(() => vi.unstubAllGlobals());
 it("lifecycle intent memory survives navigation only for its verified owner", () => {
  const memory = createLifecycleIntentMemory(); memory.bind(account);
  expect(memory.set(account, { kind: "idea_attachment", input, outcome: "uncertain", receipt: null })).toBe(true);
  expect(memory.hasUnsaved()).toBe(true); memory.bind(null); expect(memory.get(account, "idea_attachment")).toBeNull();
  const recovered = { ...account, generation: 3 }; memory.bind(recovered);
  expect(memory.get(recovered, "idea_attachment")?.input).toEqual(input);
  expect(memory.set(recovered, { kind: "idea_attachment", input: { ...input, expectedIdeaRevision: 3 }, outcome: "pending", receipt: null })).toBe(false);
  expect(memory.set(account, { kind: "idea_attachment", input, outcome: "confirmed", receipt: outcome() })).toBe(false);
  memory.bind({ ...recovered, userId: other }); expect(memory.hasUnsaved()).toBe(false);
 });
 it("attached Idea remains frozen after later edits", () => {
  const memory = createLifecycleIntentMemory(); memory.bind(account); const source = outcome();
  memory.set(account, { kind: "idea_attachment", input, outcome: "confirmed", receipt: source });
  source.attachment.source.content.description = "Later edit";
  const result = memory.get(account, "idea_attachment");
  expect(result?.receipt && "attachment" in result.receipt && result.receipt.attachment.source.content.description).toBe("Version two");
  expect(memory.hasUnsaved()).toBe(false); expect(Object.isFrozen(result?.receipt)).toBe(true);
 });
 it("checks source, target, owner and key before accepting a receipt", async () => {
  const client = createAccountLifecycleClient(account, () => true, vi.fn());
  for (const body of [ { ...outcome(), ownerId: other }, { ...outcome(), requestKey: project }, { ...outcome(), attachment: { ...receipt(), association: { ...receipt().association, projectRevision: 3 } } } ]) {
   vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
   await expect(client.attachIdeaToProject(input)).rejects.toMatchObject({ status: 502 });
  }
 });
 it("fences a delayed private result after owner change", async () => {
  let current = true; let release!: (r: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
  const client = createAccountLifecycleClient(account, () => current, vi.fn()); const operation = client.attachIdeaToProject(input);
  current = false; release(Response.json(outcome()));
  expect(await operation).toBeNull();
 });
 it("uncertain association retries the same intent once through an explicit exact-key read", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ status: "committed", receipt: outcome() }));
  vi.stubGlobal("fetch", fetcher);
  const client = createAccountLifecycleClient(account, () => true, vi.fn());
  expect(await client.readIdeaProjectAttachmentRequest(key)).toEqual({ status: "committed", receipt: outcome() });
  expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0]?.[0]).toContain(`/requests/${key}`);
 });
});

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AttachIdeaControl } from "@/features/idea-project-attachment/attach-control";
import { ProjectIdeaAttachments } from "@/features/idea-project-attachment/project-attachments";
import { ideaRecordSchema } from "@/domain/ideas";
import { contextSnapshotSchema } from "@/domain/projects";
const sessionFixture = vi.hoisted(() => ({ isCurrent: vi.fn(() => true), expire: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => sessionFixture }));
vi.mock("@/components/tools/standalone-project-picker", () => ({ StandaloneProjectPicker: ({ onSelect }: { onSelect(value: { id: string; title: string }): void }) => createElement("button", { type: "button", onClick: () => onSelect({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", title: "Saved fixture" }) }, "Choose fixture brand") }));
const savedIdea = ideaRecordSchema.parse({ id: key, ownerId: owner, revision: 2, content: ideaContentSchema.parse({ title: "Frozen Idea", description: "Version two" }), links: [], createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z" });
describe("mounted Idea attachment controls", () => {
 let root: Root | null = null;
 afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.useRealTimers(); sessionFixture.isCurrent.mockReturnValue(true); vi.unstubAllGlobals(); });
 it("requires saved edits, loads the selected owned revision and deduplicates explicit attach clicks", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const memory = createLifecycleIntentMemory(); memory.bind(account);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const fetched: { path: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, options: RequestInit) => {
   const body = options.body ? JSON.parse(String(options.body)) : undefined; fetched.push({ path, body });
   if (options.method === "GET") return Response.json({ project: { id: project, owner_id: owner, title: "Saved fixture", scope: "complete_brand", current_revision: 4, created_at: "2026-10-07T00:00:00Z", context: contextSnapshotSchema.parse({}) } });
   return Response.json(outcome(body));
  }));
  const render = async (dirty: boolean) => act(async () => root!.render(createElement(AttachIdeaControl, { account, idea: savedIdea, dirty, pending: false, memory })));
  await render(true); await act(async () => ([...host.querySelectorAll("button")].find(b => b.textContent === "Choose fixture brand")!).click());
  const attach = () => [...host.querySelectorAll("button")].find(b => b.textContent === "Attach to brand")!;
  expect(attach().disabled).toBe(true); expect(fetched).toHaveLength(0);
  await render(false); await act(async () => { attach().click(); attach().click(); });
  expect(fetched).toHaveLength(2); expect(fetched[0]?.path).toBe(`/api/projects/${project}`);
  expect(fetched[1]?.body).toMatchObject({ ideaId: key, expectedIdeaRevision: 2, projectId: project, expectedProjectRevision: 4 });
  expect(host.textContent).toContain("Idea version 2 attached"); expect(memory.hasUnsaved()).toBe(false);
  await act(async () => { [...host.querySelectorAll("button")].find(b => b.textContent === "Attach to brand" || b.textContent === "Attached to brand")!.click(); });
  expect(fetched).toHaveLength(2); expect(memory.hasUnsaved()).toBe(false);
 });
 it("allows a different Idea after a confirmed attachment while preserving unresolved other-Idea recovery", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const memory = createLifecycleIntentMemory(); memory.bind(account);
  memory.set(account, { kind: "idea_attachment", input, outcome: "confirmed", receipt: outcome() });
  const secondIdea = { ...savedIdea, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" };
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(AttachIdeaControl, { account, idea: secondIdea, dirty: false, pending: false, memory })));
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Choose fixture brand")!.click());
  expect([...host.querySelectorAll("button")].find(b => b.textContent === "Attach to brand")!.disabled).toBe(false);
  expect(host.textContent).not.toContain("Idea version 2 attached");
  await act(async () => { memory.set(account, { kind: "idea_attachment", input: { ...input, requestKey: "ffffffff-ffff-4fff-8fff-ffffffffffff" }, outcome: "uncertain", receipt: null }); });
  expect([...host.querySelectorAll("button")].find(b => b.textContent === "Check and retry original attachment")!.disabled).toBe(true);
  expect(host.textContent).toContain("Open that Idea to recover it");
 });
 it("lists frozen source pages without repeating or replacing the first page", async () => {
  vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const secondId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const first = receipt(), second = { ...receipt(), requestKey: secondId, association: { ...receipt().association, id: secondId, ideaId: secondId }, source: { content: ideaContentSchema.parse({ title: "Second frozen Idea" }) } };
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ownerId: owner, projectId: project, items: [first], nextCursor: key })).mockResolvedValueOnce(Response.json({ ownerId: owner, projectId: project, items: [second], nextCursor: null }));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root!.render(createElement(ProjectIdeaAttachments, { account, projectId: project })));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Load more Idea sources")!.click());
  expect(host.textContent).toContain("Frozen Idea"); expect(host.textContent).toContain("Second frozen Idea"); expect(host.textContent).not.toContain("could not be loaded"); expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it("recovers an already-attached proof after an owner round trip and a lost duplicate acknowledgement", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); const memory = createLifecycleIntentMemory(); memory.bind(account);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const attempts = new Map<string, IdeaProjectAttachmentOutcome>(); let original: ReturnType<typeof receipt> | null = null, headRevision = 4, posts = 0;
  vi.stubGlobal("fetch", vi.fn(async (path: string, options: RequestInit) => {
   if (path.includes("/requests/")) return Response.json({ status: "committed", receipt: attempts.get(path.split("/").at(-1)!) });
   if (options.method === "GET") return Response.json({ project: { id: project, owner_id: owner, title: "Saved fixture", scope: "complete_brand", current_revision: headRevision, created_at: "2026-10-07T00:00:00Z", context: contextSnapshotSchema.parse({}) } });
   const attempt = JSON.parse(String(options.body)) as AttachIdeaToProjectInput; posts++;
   const disposition = original ? "already_attached" : "attached";
   original ??= { ...receipt(), requestKey: attempt.requestKey };
   const result: IdeaProjectAttachmentOutcome = { ownerId: owner, requestKey: attempt.requestKey, input: attempt, status: disposition, attachment: original }; attempts.set(attempt.requestKey, result);
   if (posts === 2) throw new TypeError("Lost duplicate acknowledgement after durable request receipt");
   return Response.json(result);
  }));
  const render = async (verified: VerifiedAccount) => act(async () => root!.render(createElement(AttachIdeaControl, { account: verified, idea: savedIdea, dirty: false, pending: false, memory })));
  const click = async (label: string) => act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === label)!.click());
  await render(account); await click("Choose fixture brand"); await click("Attach to brand"); expect(posts).toBe(1);
  memory.bind({ ...account, userId: other, generation: 2 }); const recovered = { ...account, generation: 3 }; memory.bind(recovered); headRevision = 9;
  await render(recovered); await click("Choose fixture brand"); await click("Attach to brand");
  expect(memory.get(recovered, "idea_attachment")?.outcome).toBe("uncertain");
  await click("Check and retry original attachment");
  expect(memory.hasUnsaved()).toBe(false); expect(posts).toBe(2);
  expect(host.textContent).toContain("already attached at brand revision 4"); expect(host.textContent).not.toContain("brand revision 9");
 });

});
