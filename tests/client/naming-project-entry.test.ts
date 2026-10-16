import { expect, it, vi } from "vitest";
import { startNamingProject } from "@/components/naming/naming-project-entry";
import { createNamingBrainMemory } from "@/components/naming/naming-brain-memory";
import { AccountRequestError } from "@/components/workspace/account-api";
const account = { userId: "a0000000-0000-4000-8000-000000000001", generation: 1 }, projectId = "b0000000-0000-4000-8000-000000000001";
it("creates only on explicit submission and retries the exact project input after a lost acknowledgement", async () => {
  const memory = createNamingBrainMemory({ storage: () => null }); memory.bind(account);
  memory.setEntry(account, previous => ({ ...previous, description: "A synthetic coffee studio", direction: "Warm and concise", language: "French" }));
  const bodies: unknown[] = []; const request = vi.fn(async (_path, _schema, options) => {
    expect(new Headers({ "X-Embel-Account": options.expectedOwnerId }).get("X-Embel-Account")).toBe(account.userId);
    bodies.push(options.body); if (bodies.length === 1) throw new AccountRequestError(408);
    const body = options.body;
    return { project: { id: projectId, owner_id: account.userId, title: body.title, scope: "naming_only", context: body.context, current_revision: 1, created_at: "2026-10-16T12:00:00Z" } };
  });
  expect(request).not.toHaveBeenCalled();
  expect(await startNamingProject({ memory, account, request: request as never })).toBeNull();
  expect(memory.getEntry(account)?.input).toMatchObject({ scope: "naming_only", context: { description: "A synthetic coffee studio", creativeLocale: "French", intake: { namingNotes: "Warm and concise" } } });
  expect(await startNamingProject({ memory, account, request: request as never })).toBe(projectId);
  expect(bodies[1]).toEqual(bodies[0]); expect(bodies[0]).not.toHaveProperty("ownerId");
  expect(await startNamingProject({ memory, account, request: request as never })).toBe(projectId); expect(bodies).toHaveLength(2);
});
it("cannot navigate or publish a late project creation into another account", async () => {
  const memory = createNamingBrainMemory({ storage: () => null }); memory.bind(account);
  memory.setEntry(account, value => ({ ...value, description: "Private owner A brief" }));
  let finish!: (value: unknown) => void;
  const pending = startNamingProject({ memory, account, request: (async (_path: string, _schema: unknown, options: { body: { title: string; context: unknown } }) => new Promise(resolve => { finish = () => resolve({ project: { id: projectId, owner_id: account.userId, title: options.body.title, scope: "naming_only", context: options.body.context, current_revision: 1, created_at: "2026-10-16T12:00:00Z" } }); })) as never });
  memory.bind({ userId: "a0000000-0000-4000-8000-000000000002", generation: 2 }); finish(null);
  expect(await pending).toBeNull(); expect(memory.getEntry(account)).toBeNull();
});
it("resumes an idempotently created project that was later expanded without replacing its current context", async () => {
  const memory = createNamingBrainMemory({ storage: () => null }); memory.bind(account);
  memory.setEntry(account, value => ({ ...value, description: "Original Naming brief" }));
  let count = 0;
  const request = vi.fn(async (_path, _schema, options) => {
    count++;
    if (count === 1) throw new AccountRequestError(408);
    return { project: { id: projectId, owner_id: account.userId, title: "Expanded project", scope: "complete_brand", context: { ...options.body.context, description: "Later owner-authored context" }, current_revision: 2, created_at: "2026-10-16T12:00:00Z" } };
  });
  expect(await startNamingProject({ memory, account, request: request as never })).toBeNull();
  expect(await startNamingProject({ memory, account, request: request as never })).toBe(projectId);
  expect(memory.getEntry(account)?.description).toBe("Original Naming brief");
});
it("allows correction after a definitive validation rejection instead of freezing an unsaveable brief", async () => {
  const memory = createNamingBrainMemory({ storage: () => null }); memory.bind(account);
  memory.setEntry(account, value => ({ ...value, description: "A brief the server rejects" }));
  expect(await startNamingProject({ memory, account, request: (async () => { throw new AccountRequestError(422); }) as never })).toBeNull();
  expect(memory.getEntry(account)?.input).toBeNull(); expect(memory.getEntry(account)?.description).toBe("A brief the server rejects");
});
it("keeps an automatic title valid when its truncation boundary crosses a supplementary character", async () => {
  const memory = createNamingBrainMemory({ storage: () => null }); memory.bind(account);
  memory.setEntry(account, value => ({ ...value, description: "A".repeat(99) + "😀 coffee" }));
  const request = vi.fn(async (_path, _schema, options) => {
    expect(options.body.title.isWellFormed()).toBe(true);
    return { project: { id: projectId, owner_id: account.userId, title: options.body.title, scope: options.body.scope, context: options.body.context, current_revision: 1, created_at: "2026-10-16T12:00:00Z" } };
  });
  expect(await startNamingProject({ memory, account, request: request as never })).toBe(projectId);
});
