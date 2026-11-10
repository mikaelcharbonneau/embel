// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { createInspirationMemory } from "@/components/inspiration/inspiration-memory";
import { useInspiration } from "@/components/inspiration/use-inspiration";
import {
  inspirationCatalog,
  inspirationMutationSchema,
  INSPIRATION_CATALOG_VERSION,
  type InspirationOverview,
} from "@/domain/inspiration";
const mock = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => mock.session() }));
const account = { status: "ready" as const, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 },
  projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  id = inspirationCatalog[0]!.id;
let root: Root, api: ReturnType<typeof useInspiration>, fetcher: ReturnType<typeof vi.fn>, saved: InspirationOverview;
function Harness() {
  const value = useInspiration(account, projectId);
  useLayoutEffect(() => {
    api = value;
  });
  return null;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const inspirationDrafts = createInspirationMemory();
  inspirationDrafts.bind(account);
  mock.session.mockReturnValue({
    inspirationDrafts,
    drafts: createAccountDraftMemory(),
    isCurrent: () => true,
    expire: vi.fn(),
  });
  saved = {
    ownerId: account.userId,
    projectId,
    projectTitle: "Fixture",
    projectScope: "complete_brand",
    projectRevision: 1,
    catalogVersion: INSPIRATION_CATALOG_VERSION,
    selectionRevision: 0,
    choices: [],
  };
  fetcher = vi.fn(async (_path: string, init: RequestInit) => {
    if (init.method === "PATCH") {
      const input = inspirationMutationSchema.parse(JSON.parse(String(init.body)));
      expect(input.expectedRevision).toBe(saved.choices[0]?.revision ?? 0);
      saved = {
        ...saved,
        selectionRevision: saved.selectionRevision + 1,
        choices: [
          {
            ownerId: account.userId,
            projectId,
            referenceId: id,
            revision: input.expectedRevision + 1,
            ensemble: input.ensemble,
            elements: input.elements,
            updatedAt: "2026-10-13T00:00:00Z",
          },
        ],
      };
    }
    return Response.json(saved);
  });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
it("edits an already saved reaction repeatedly without sending its owner/project receipt fields", async () => {
  await act(async () => root.render(createElement(Harness)));
  expect(api.canSave).toBe(true);
  await act(async () => {
    await api.save(id, { ensemble: false, elements: ["colors"] });
  });
  expect(api.overview?.choices[0]).toMatchObject({ ensemble: false, elements: ["colors"], revision: 1 });
  await act(async () => {
    await api.save(id, { ...api.overview!.choices[0]!, ensemble: true });
  });
  expect(api.overview?.choices[0]).toMatchObject({ ensemble: true, elements: ["colors"], revision: 2 });
  await act(async () => {
    await api.save(id, { ...api.overview!.choices[0]!, ensemble: false });
  });
  expect(api.overview?.choices[0]).toMatchObject({ ensemble: false, elements: ["colors"], revision: 3 });
  expect(api.intents.size).toBe(0);
  const writes = fetcher.mock.calls.filter(([, init]) => init.method === "PATCH");
  expect(writes).toHaveLength(3);
  for (const [, init] of writes)
    expect(Object.keys(JSON.parse(init.body)).sort()).toEqual([
      "catalogVersion",
      "elements",
      "ensemble",
      "expectedProjectRevision",
      "expectedRevision",
    ]);
});
