/** Genuine React SSR smoke checks only; browser lifecycle/races remain QA acceptance. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountSessionProvider } from "../../src/components/workspace/account-session";
import {
  createLogoDraftMemory,
  LogoDraftMemoryProvider,
  useLogoDraftMemory,
} from "../../src/components/identity/logo-draft-memory";
import { useLogoWorkspace } from "../../src/components/identity/use-logo-workspace";

describe("logo provider and hook SSR privacy", () => {
  it("requires the provider instead of creating a replacement private store", () => {
    function Read() {
      useLogoDraftMemory();
      return null;
    }
    expect(() => renderToStaticMarkup(createElement(Read))).toThrow("Logo draft memory provider is required");
  });
  it("returns exactly the provider's store", () => {
    const memory = createLogoDraftMemory();
    function Read() {
      return createElement("span", null, useLogoDraftMemory() === memory ? "same store" : "wrong store");
    }
    expect(
      renderToStaticMarkup(
        <LogoDraftMemoryProvider memory={memory}>
          <Read />
        </LogoDraftMemoryProvider>,
      ),
    ).toBe("<span>same store</span>");
  });
  it("hides provider-private draft data until the account session is verified", () => {
    const memory = createLogoDraftMemory();
    memory.bind({ ownerId: fixtureAccount.userId, generation: 1 });
    const saved = baselineFixture().workspace;
    memory.set(fixtureProject, {
      workspace: saved,
      base: saved.heads,
      brief: { name: "Private draft", activity: "", audience: "", personality: "", logoTypes: [] },
      references: [],
      dirty: true,
      pendingExport: null,
      pendingMutation: null,
      conflict: false,
    });
    function Read() {
      const result = useLogoWorkspace({ projectId: fixtureProject, memory });
      expect(result.status).toBe("unverified");
      expect(result.draft).toBeNull();
      expect(result.workspace).toBeNull();
      expect(result.canEdit).toBe(false);
      expect(result.client).toBeNull();
      expect(result.stagePayloads).toBeNull();
      return createElement("span", null, result.status);
    }
    expect(
      renderToStaticMarkup(
        <AccountSessionProvider>
          <Read />
        </AccountSessionProvider>,
      ),
    ).toBe("<span>unverified</span>");
    expect(memory.hasUnsaved()).toBe(true);
  });
});

// The actual read-only loader used by the hook, with synthetic HTTP and real
// client/memory code. This does not substitute for React effect/browser proof.
import { vi } from "vitest";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { loadLogoWorkspaceBaseline } from "../../src/components/identity/use-logo-workspace";
import { logoWorkspaceV2Schema } from "../../src/domain/logo-workspace";

const fixtureId = (n: number) => `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fixtureAccount = { status: "ready" as const, userId: fixtureId(1), generation: 1 },
  fixtureProject = fixtureId(2);
function baselineFixture() {
  const heads = {
    projectRevision: 1,
    referenceRevision: 1,
    preferencesRevision: 0,
    workspaceRevision: 1,
    stageRevisions: { brief_references: 1, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 },
  };
  const brief = {
    name: "Saved Cedar",
    activity: "Studio",
    audience: "Founders",
    personality: "Calm",
    logoTypes: ["wordmark" as const],
  };
  const workspace = logoWorkspaceV2Schema.parse({
    version: 2,
    ownerId: fixtureAccount.userId,
    projectId: fixtureProject,
    heads,
    stages: {
      brief_references: { stage: "brief_references", id: fixtureId(3), revision: 1 },
      concepts: null,
      vector: null,
      refinements: null,
      directions: null,
      deliverables: null,
    },
    approvedLogo: null,
    staleStages: [],
    capabilities: Object.fromEntries(
      ["save", "upload", "generate", "convert", "export"].map((key) => [
        key,
        { status: "unavailable", reason: "Synthetic test only" },
      ]),
    ),
  });
  const stage = {
    version: 2,
    id: fixtureId(3),
    ownerId: fixtureAccount.userId,
    projectId: fixtureProject,
    stage: "brief_references",
    revision: 1,
    parentRevisionId: null,
    inputRevisions: [],
    inputHash: "a".repeat(64),
    createdAt: "2026-10-06T12:00:00Z",
    payload: { ...brief, referenceSnapshotId: fixtureId(4), sourceProjectRevision: 1 },
  };
  const snapshot = {
    version: 2,
    id: fixtureId(4),
    ownerId: fixtureAccount.userId,
    projectId: fixtureProject,
    revision: 1,
    references: [
      {
        referenceId: fixtureId(5),
        asset: {
          ownerId: fixtureAccount.userId,
          projectId: fixtureProject,
          assetId: fixtureId(6),
          versionId: fixtureId(7),
          contentHash: "b".repeat(64),
        },
        sourceKind: "upload",
        aspects: ["shape", "overall_feel"],
        rightsEvidenceId: fixtureId(8),
      },
    ],
  };
  return { workspace, stage, snapshot, brief };
}
function baselineTransport(fixture = baselineFixture(), snapshotResponse?: () => Promise<Response>) {
  const paths: string[] = [];
  const client = createAccountLogoClient(
    fixtureAccount,
    fixtureProject,
    () => true,
    vi.fn(),
    async (path) => {
      const url = String(path);
      paths.push(url);
      if (url.endsWith(`/reference-snapshots/${fixtureId(4)}`))
        return snapshotResponse ? snapshotResponse() : Response.json(fixture.snapshot);
      if (url.endsWith(`/stages/brief_references/revisions/${fixtureId(3)}`)) return Response.json(fixture.stage);
      if (url.endsWith("/logo")) return Response.json(fixture.workspace);
      throw new Error("Unexpected registration or mutation request");
    },
  );
  return { client, paths };
}
function baselineMemory() {
  const memory = createLogoDraftMemory();
  memory.bind({ ownerId: fixtureAccount.userId, generation: fixtureAccount.generation });
  return memory;
}

it("hydrates the exact saved subset/aspects and retains immutable snapshot version/hash metadata", async () => {
  const fixture = baselineFixture(),
    { client, paths } = baselineTransport(fixture),
    memory = baselineMemory();
  const result = await loadLogoWorkspaceBaseline({
    client,
    account: fixtureAccount,
    projectId: fixtureProject,
    memory,
    signal: new AbortController().signal,
  });
  expect(result?.brief).toEqual(fixture.brief);
  expect(result?.references).toEqual([{ referenceId: fixtureId(5), aspects: ["shape", "overall_feel"] }]);
  expect(result?.referenceSnapshot).toEqual(fixture.snapshot);
  expect(paths).toHaveLength(3);
  expect(memory.get(fixtureProject)).toBeNull();
});

it("accepts saved zero references only from an actual admitted empty snapshot; unavailable reads fail", async () => {
  const fixture = baselineFixture();
  fixture.snapshot.references = [];
  const memory = baselineMemory(),
    { client } = baselineTransport(fixture);
  expect(
    (
      await loadLogoWorkspaceBaseline({
        client,
        account: fixtureAccount,
        projectId: fixtureProject,
        memory,
        signal: new AbortController().signal,
      })
    )?.references,
  ).toEqual([]);
  const unavailable = baselineTransport(fixture, async () => new Response(null, { status: 503 })).client;
  await expect(
    loadLogoWorkspaceBaseline({
      client: unavailable,
      account: fixtureAccount,
      projectId: fixtureProject,
      memory,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ status: 503 });
  expect(memory.get(fixtureProject)).toBeNull();
});

it("rejects stale hydration after another consumer replaces memory with dirty work", async () => {
  const fixture = baselineFixture(),
    memory = baselineMemory();
  let resolve!: (value: Response) => void, reached!: () => void;
  const started = new Promise<void>((yes) => {
    reached = yes;
  });
  const response = new Promise<Response>((yes) => {
    resolve = yes;
  });
  const { client } = baselineTransport(fixture, () => {
    reached();
    return response;
  });
  const load = loadLogoWorkspaceBaseline({
    client,
    account: fixtureAccount,
    projectId: fixtureProject,
    memory,
    signal: new AbortController().signal,
  });
  await started;
  memory.set(fixtureProject, {
    workspace: fixture.workspace,
    base: fixture.workspace.heads,
    brief: { ...fixture.brief, name: "Keep this dirty work" },
    references: [],
    dirty: true,
    pendingExport: null,
    pendingMutation: null,
    conflict: false,
  });
  resolve(Response.json(fixture.snapshot));
  expect(await load).toBeNull();
  expect(memory.get(fixtureProject)?.brief.name).toBe("Keep this dirty work");
});
