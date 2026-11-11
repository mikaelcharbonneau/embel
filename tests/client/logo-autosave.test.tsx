// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountLogoClient } from "../../src/components/identity/account-logo-client";
import { createLogoDraftMemory, type LogoDraftMemory } from "../../src/components/identity/logo-draft-memory";
import {
  LOGO_AUTOSAVE_DELAY_MS,
  LOGO_SAVE_TIMEOUT_MS,
  useLogoWorkspace,
} from "../../src/components/identity/use-logo-workspace";
import {
  logoMutationReceiptSchema,
  logoReferenceSnapshotSchema,
  logoStageRevisionSchema,
  logoWorkspaceV2Schema,
  type LogoBriefDraft,
  type LogoMutationReceipt,
  type LogoReferenceSelection,
  type LogoStageRevision,
} from "../../src/domain/logo-workspace";
import { logoFixtureId as id, syntheticLogoWorkspace, syntheticResolvedLogoConcept } from "../fixtures/logo-creation";

const session = vi.hoisted(() => ({
  account: { status: "ready" as const, userId: "00000000-0000-4000-8000-000000000001", generation: 1 },
  current: true,
  isCurrent: vi.fn(),
  expire: vi.fn(),
}));
vi.mock("../../src/components/workspace/account-session", () => ({
  useAccountSession: () => ({ session: session.account, isCurrent: session.isCurrent, expire: session.expire }),
}));

type SaveInput = {
  requestKey: string;
  expected: ReturnType<typeof syntheticLogoWorkspace>["heads"];
  brief?: LogoBriefDraft;
  selections?: LogoReferenceSelection[];
};
type Write = { path: string; input: SaveInput; signal: AbortSignal; resolve(response: Response): void };
type State = ReturnType<typeof useLogoWorkspace>;
let root: Root, host: HTMLDivElement, state: State, memory: LogoDraftMemory;
const clients: ReturnType<typeof createAccountLogoClient>[] = [];

function fixture(initialized = true) {
  const source = syntheticResolvedLogoConcept(),
    scope = { ownerId: source.brief.ownerId, projectId: source.brief.projectId };
  const stages = new Map<string, LogoStageRevision>([[source.brief.id, source.brief]]);
  const snapshots = new Map([[source.referenceSnapshot.id, source.referenceSnapshot]]);
  const receipts = new Map<string, LogoMutationReceipt>();
  const base = syntheticLogoWorkspace();
  const f = {
    workspace: logoWorkspaceV2Schema.parse({
      ...base,
      heads: {
        ...base.heads,
        referenceRevision: 1,
        workspaceRevision: initialized ? 1 : 0,
        stageRevisions: { ...base.heads.stageRevisions, brief_references: initialized ? 1 : 0 },
      },
      stages: {
        ...base.stages,
        brief_references: initialized ? { stage: "brief_references", id: source.brief.id, revision: 1 } : null,
      },
      capabilities: { ...base.capabilities, save: { status: "available" } },
    }),
    brief: source.brief,
    writes: [] as Write[],
    reads: [] as string[],
    commit(write: Write): LogoMutationReceipt {
      expect(write.input.expected).toEqual(f.workspace.heads);
      const revision = f.brief.revision + 1;
      const previousSnapshot = snapshots.get(f.brief.payload.referenceSnapshotId)!;
      const snapshot = write.input.selections
        ? logoReferenceSnapshotSchema.parse({
            ...previousSnapshot,
            id: id(2000 + revision),
            revision: previousSnapshot.revision + 1,
            references: write.input.selections.map((selection) => ({
              ...selection,
              sourceKind: "upload",
              rightsEvidenceId: id(1900),
              asset: { ...scope, assetId: id(1901), versionId: id(1902), contentHash: "c".repeat(64) },
            })),
          })
        : previousSnapshot;
      snapshots.set(snapshot.id, snapshot);
      f.brief = logoStageRevisionSchema.parse({
        ...f.brief,
        id: id(1000 + revision),
        revision,
        parentRevisionId: f.brief.id,
        payload: { ...f.brief.payload, ...write.input.brief, referenceSnapshotId: snapshot.id },
      }) as typeof source.brief;
      stages.set(f.brief.id, f.brief);
      f.workspace = logoWorkspaceV2Schema.parse({
        ...f.workspace,
        heads: {
          ...f.workspace.heads,
          workspaceRevision: f.workspace.heads.workspaceRevision + 1,
          referenceRevision: snapshot.revision,
          stageRevisions: { ...f.workspace.heads.stageRevisions, brief_references: revision },
        },
        stages: { ...f.workspace.stages, brief_references: { stage: "brief_references", id: f.brief.id, revision } },
      });
      const receipt = logoMutationReceiptSchema.parse({
        ...scope,
        requestKey: write.input.requestKey,
        workspace: f.workspace,
        revision: f.brief,
      });
      receipts.set(receipt.requestKey, receipt);
      return receipt;
    },
    fetcher: vi.fn(async (path: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(path);
      if (init?.method === "PUT")
        return new Promise<Response>((resolve) =>
          f.writes.push({
            path: url,
            input: JSON.parse(String(init.body)) as SaveInput,
            signal: init.signal!,
            resolve,
          }),
        );
      if (init?.method && init.method !== "GET") throw Error("Unexpected project creation or AI request");
      f.reads.push(url);
      if (url.endsWith("/logo")) return Response.json(f.workspace);
      const stageId = url.split("/revisions/")[1];
      if (stageId) return Response.json(stages.get(stageId));
      const snapshotId = url.split("/reference-snapshots/")[1];
      if (snapshotId) return Response.json(snapshots.get(snapshotId));
      const key = url.split("/requests/")[1];
      if (key)
        return Response.json(
          receipts.has(key)
            ? {
                status: "succeeded",
                requestKey: key,
                receipt: receipts.get(key),
                outputs: [],
                billing: { status: "recorded", confirmedMicrousd: 0 },
                reason: null,
              }
            : { status: "not_found" },
        );
      throw Error(`Unexpected read: ${url}`);
    }),
  };
  return f;
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function mount(f: ReturnType<typeof fixture>, projectId: string = f.workspace.projectId) {
  const client = createAccountLogoClient(session.account, projectId, session.isCurrent, session.expire, f.fetcher);
  clients.push(client);
  function Probe() {
    const value = useLogoWorkspace({ projectId, memory, client });
    useLayoutEffect(() => {
      state = value;
    });
    return <p>{value.saving ? "Saving" : value.pending ? "Unconfirmed" : value.dirty ? "Unsaved" : "Saved"}</p>;
  }
  await act(async () => root.render(<Probe />));
  await tick(0);
  expect(state.status).toBe("ready");
  return client;
}
async function editBrief(change: Partial<LogoBriefDraft>) {
  await act(async () => state.setBriefDraft({ ...state.draft!.brief, ...change }));
}
async function acknowledge(f: ReturnType<typeof fixture>, index: number) {
  await act(async () => f.writes[index]!.resolve(Response.json(f.commit(f.writes[index]!))));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  session.current = true;
  session.isCurrent
    .mockReset()
    .mockImplementation(
      (account) =>
        session.current &&
        account.userId === session.account.userId &&
        account.generation === session.account.generation,
    );
  session.expire.mockReset();
  memory = createLogoDraftMemory();
  memory.bind({ ownerId: session.account.userId, generation: session.account.generation });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  clients.splice(0).forEach((client) => client.dispose());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Logo brief and reference autosave", () => {
  it("debounces ordinary edits and displays Saved only after the receipt and reference snapshot are confirmed", async () => {
    const f = fixture();
    await mount(f);
    await editBrief({ name: "Cedar" });
    await tick(400);
    await editBrief({ name: "Cedar Studio" });
    await tick(LOGO_AUTOSAVE_DELAY_MS - 1);
    expect(f.writes).toHaveLength(0);
    expect(host.textContent).toBe("Unsaved");
    await tick(1);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.input.brief?.name).toBe("Cedar Studio");
    expect(host.textContent).toBe("Saving");
    expect(state.canEdit).toBe(true);
    expect(state.dirty).toBe(true);
    const readSnapshot = f.fetcher.getMockImplementation()!;
    let releaseSnapshot!: () => void;
    f.fetcher.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      return readSnapshot(...args);
    });
    await acknowledge(f, 0);
    expect(host.textContent).toBe("Saving");
    expect(state.draft?.pendingMutation).toBeTruthy();
    await act(async () => releaseSnapshot());
    expect(host.textContent).toBe("Saved");
    expect(state.draft?.pendingMutation).toBeNull();
    await tick(5000);
    expect(f.writes).toHaveLength(1);
  });

  it("preserves newer typing during a save and serializes it using the acknowledged revision", async () => {
    const f = fixture();
    await mount(f);
    await editBrief({ name: "Cedar" });
    await tick(LOGO_AUTOSAVE_DELAY_MS);
    const original = structuredClone(state.draft!.pendingMutation);
    await editBrief({ name: "Cedar & Pine" });
    await tick(2000);
    expect(state.draft?.brief.name).toBe("Cedar & Pine");
    expect(state.draft?.pendingMutation).toEqual(original);
    expect(f.writes).toHaveLength(1);
    await acknowledge(f, 0);
    expect(state.dirty).toBe(true);
    expect(state.draft?.brief.name).toBe("Cedar & Pine");
    await tick(LOGO_AUTOSAVE_DELAY_MS);
    expect(f.writes).toHaveLength(2);
    expect(f.writes[1]!.input.expected).toEqual(f.workspace.heads);
    expect(f.writes[1]!.input.requestKey).not.toBe(f.writes[0]!.input.requestKey);
    await acknowledge(f, 1);
    expect(state.dirty).toBe(false);
    expect(f.brief.payload.name).toBe("Cedar & Pine");
  });

  it("serializes a changed brief and reference selection without discarding either draft", async () => {
    const f = fixture();
    await mount(f);
    const selections: LogoReferenceSelection[] = [{ referenceId: id(1800), aspects: ["shape"] }];
    await act(async () => {
      state.setBriefDraft({ ...state.draft!.brief, audience: "Independent studios" });
      state.setReferenceDraft(selections);
    });
    await tick(LOGO_AUTOSAVE_DELAY_MS);
    expect(f.writes[0]!.path).toMatch(/\/brief$/);
    await acknowledge(f, 0);
    expect(state.dirty).toBe(true);
    expect(state.draft?.references).toEqual(selections);
    await tick(LOGO_AUTOSAVE_DELAY_MS);
    expect(f.writes[1]!.path).toMatch(/\/references$/);
    await acknowledge(f, 1);
    expect(state.dirty).toBe(false);
    expect(state.referenceSnapshot?.references[0]?.aspects).toEqual(["shape"]);
  });

  it("retains incomplete input and saves it once corrected without sending an invalid write", async () => {
    const f = fixture();
    await mount(f);
    await editBrief({ name: "" });
    await tick(5000);
    expect(f.writes).toHaveLength(0);
    expect(memory.hasUnsaved()).toBe(true);
    await editBrief({ name: "Cedar" });
    await tick(LOGO_AUTOSAVE_DELAY_MS);
    expect(f.writes).toHaveLength(1);
  });

  it.each(["vector", "direction"] as const)(
    "does not queue brief autosave while a protected %s draft remains",
    async (kind) => {
      const f = fixture();
      await mount(f);
      await act(async () => {
        memory.set(f.workspace.projectId, {
          ...state.draft!,
          ...(kind === "vector"
            ? {
                vectorDraft: {
                  baseVectorRevisionId: id(400),
                  edit: { kind: "rotation", componentId: "symbol", degrees: 15 },
                },
              }
            : {
                directionDraft: {
                  approvedLogoId: id(400),
                  paletteVersionId: id(401),
                  typographyVersionId: id(402),
                  graphicsVersionId: id(403),
                  reviewedConsistencyHash: null,
                },
              }),
        });
      });
      expect(state.dirty).toBe(true);
      expect(state.autoSaveReady).toBe(false);
      await editBrief({ name: "Cedar" });
      await tick(5000);
      expect(state.autoSaveReady).toBe(false);
      expect(f.writes).toHaveLength(0);
      await act(async () => {
        memory.set(f.workspace.projectId, { ...state.draft!, vectorDraft: null, directionDraft: null });
      });
      expect(state.autoSaveReady).toBe(true);
      await tick(LOGO_AUTOSAVE_DELAY_MS);
      expect(f.writes).toHaveLength(1);
    },
  );

  it("does not automatically initialize an existing empty Logo workspace", async () => {
    const f = fixture(false);
    await mount(f);
    await editBrief({ name: "Cedar", logoTypes: ["wordmark"] });
    await tick(5000);
    expect(f.writes).toHaveLength(0);
    expect(f.fetcher.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    expect(state.dirty).toBe(true);
  });

  it("bounds a stalled acknowledgement, keeps its exact request, and recovers a committed result without another write", async () => {
    const f = fixture();
    await mount(f);
    await editBrief({ name: "Cedar" });
    await tick(LOGO_AUTOSAVE_DELAY_MS);
    const original = structuredClone(state.draft!.pendingMutation),
      write = f.writes[0]!;
    const receipt = f.commit(write);
    await tick(LOGO_SAVE_TIMEOUT_MS);
    expect(write.signal.aborted).toBe(true);
    expect(state.saving).toBe(false);
    expect(state.pending).toBe(true);
    expect(state.error).toBeTruthy();
    expect(state.draft?.pendingMutation).toEqual(original);
    await tick(60_000);
    expect(f.writes).toHaveLength(1);
    await act(async () => write.resolve(Response.json(receipt)));
    expect(state.pending).toBe(true);
    expect(state.draft?.pendingMutation).toEqual(original);
    await act(async () => {
      await state.checkPendingSave();
    });
    expect(state.dirty).toBe(false);
    expect(state.pending).toBe(false);
    expect(host.textContent).toBe("Saved");
    expect(f.writes).toHaveLength(1);
  });

  it("stops autosave on a conflict and retains changes for explicit recovery", async () => {
    const f = fixture();
    await mount(f);
    await editBrief({ name: "Cedar" });
    await tick(LOGO_AUTOSAVE_DELAY_MS);
    await act(async () => f.writes[0]!.resolve(Response.json({}, { status: 409 })));
    expect(state.draft?.conflict).toBe(true);
    expect(state.dirty).toBe(true);
    expect(state.pending).toBe(true);
    await editBrief({ name: "Cedar & Pine" });
    await tick(60_000);
    expect(f.writes).toHaveLength(1);
    expect(state.draft?.brief.name).toBe("Cedar & Pine");
  });

  it("allows another original-request check after a stalled recovery read without resending the save", async () => {
    const f = fixture();
    await mount(f);
    await editBrief({ name: "Cedar" });
    await tick(LOGO_AUTOSAVE_DELAY_MS);
    await act(async () => f.writes[0]!.resolve(Response.json({}, { status: 503 })));
    const original = structuredClone(state.draft!.pendingMutation);
    let readSignal: AbortSignal | undefined, checking!: ReturnType<State["checkPendingSave"]>;
    f.fetcher.mockImplementationOnce(async (_path, init) => {
      readSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    await act(async () => {
      checking = state.checkPendingSave();
    });
    expect(state.canEdit).toBe(false);
    expect(state.saving).toBe(false);
    await tick(LOGO_SAVE_TIMEOUT_MS);
    await act(async () => {
      await checking;
    });
    expect(readSignal?.aborted).toBe(true);
    expect(state.canEdit).toBe(true);
    expect(state.error).toBeTruthy();
    expect(state.draft?.pendingMutation).toEqual(original);
    await act(async () => {
      expect(await state.checkPendingSave()).toEqual({ status: "not_found" });
    });
    expect(state.canEdit).toBe(true);
    expect(state.draft?.pendingMutation).toEqual(original);
    expect(f.writes).toHaveLength(1);
    expect(f.fetcher.mock.calls.filter(([path]) => String(path).includes("/requests/"))).toHaveLength(2);
  });

  it("cancels queued autosave when the account is fenced", async () => {
    const f = fixture();
    await mount(f);
    await editBrief({ name: "Private edits" });
    await act(async () => {
      session.current = false;
      memory.bind(null);
    });
    await tick(LOGO_AUTOSAVE_DELAY_MS);
    expect(f.writes).toHaveLength(0);
    expect(state.draft).toBeNull();
  });
});
