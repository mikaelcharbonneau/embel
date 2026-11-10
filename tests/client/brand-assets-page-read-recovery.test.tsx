// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandAssetsPage } from "@/components/visual-directions/brand-assets-page";
import { createAccountIdentityClient } from "@/components/identity/account-identity-client";
import { createAccountLogoClient } from "@/components/identity/account-logo-client";
import type { useProjectIdentity } from "@/components/identity/use-project-identity";
import type { useLogoWorkspace } from "@/components/identity/use-logo-workspace";
import type { useAccountSession, VerifiedAccount } from "@/components/workspace/account-session";
import type { BrandAssetsPanelProps } from "@/features/brand-assets/components/brand-assets-panel";
import { identityBatchStateSchema, type IdentityBatchState } from "@/domain/identity-jobs";
import { projectIdentityOverviewSchema } from "@/domain/project-identity";
import { createVisualJourneyFixture, ownerId, projectId } from "../fixtures/visual-identity-journey";
import { fixtureId } from "./project-identity-fixtures";

type Identity = Pick<
  ReturnType<typeof useProjectIdentity>,
  "client" | "checked" | "overview" | "error" | "loading" | "refresh" | "strategyDirty" | "preferencesDirty"
>;
type Logo = Pick<
  ReturnType<typeof useLogoWorkspace>,
  "client" | "workspace" | "error" | "status" | "reload" | "dirty" | "pending"
>;
const state = vi.hoisted(() => ({
  session: null as unknown as ReturnType<typeof useAccountSession>["session"],
  isCurrent: vi.fn(),
  identity: null as unknown as Identity,
  logo: null as unknown as Logo,
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => state,
  AccountStatus: () => null,
}));
vi.mock("@/components/identity/use-project-identity", () => ({ useProjectIdentity: () => state.identity }));
vi.mock("@/components/identity/use-logo-workspace", () => ({ useLogoWorkspace: () => state.logo }));
vi.mock("@/components/identity/logo-draft-memory-context", () => ({ useLogoDraftMemory: () => null }));
// This suite owns page read/recovery behavior; packaging has its own real tests.
vi.mock("@/features/brand-assets/components/brand-assets-panel", () => ({
  BrandAssetsPanel: ({ system }: BrandAssetsPanelProps) => (
    <p data-testid="brand-assets">
      Asset package for {system.source.kind === "generated" ? system.source.batchId : system.id}
    </p>
  ),
}));

type Read = {
  batchId: string;
  signal: AbortSignal;
  resolve(value: IdentityBatchState | null): void;
  reject(error: Error): void;
};
let root: Root, host: HTMLDivElement, reads: Read[], saved: IdentityBatchState;
let clients: ReturnType<typeof createAccountIdentityClient>[];
function client() {
  const value = createAccountIdentityClient(state.session as VerifiedAccount, projectId, state.isCurrent, vi.fn());
  // Intentionally ignores cancellation so the page must settle independently
  // and reject late results, even when transport completion never arrives.
  vi.spyOn(value, "batch").mockImplementation(
    (batchId, signal) =>
      new Promise((resolve, reject) => {
        expect(signal).toBeDefined();
        reads.push({ batchId, signal: signal!, resolve, reject });
      }),
  );
  clients.push(value);
  return value;
}
async function render() {
  await act(async () => root.render(<BrandAssetsPage projectId={projectId} />));
}
async function finish(index: number, value: IdentityBatchState | null = saved) {
  await act(async () => reads[index]!.resolve(value));
}
async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}
async function retry() {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === "Check saved direction");
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
const panel = () => host.querySelector('[data-testid="brand-assets"]');

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  reads = [];
  clients = [];
  const journey = createVisualJourneyFixture(),
    ready = journey.availability();
  journey.batch = identityBatchStateSchema.parse({
    ownerId,
    projectId,
    batchId: fixtureId(400),
    jobId: fixtureId(401),
    status: "queued",
    terminal: false,
    input: journey.input,
    sourceLogo: journey.sourceLogo,
    sourceLogoCurrent: true,
    intent: {
      version: 3,
      spendControl: "uncapped",
      idempotencyKey: "brand-assets-load-fixture",
      acceptedPolicyIdentity: ready.policyIdentity,
      sourceLogo: ready.sourceLogo.source,
      expectedLogoRevision: ready.expectedLogoRevision,
      expectedProjectRevision: ready.expectedProjectRevision,
      expectedReferenceRevision: ready.expectedReferenceRevision,
      expectedPreferencesRevision: ready.expectedPreferencesRevision,
      expectedIdentityRevision: 0,
    },
    systems: [],
    fulfillment: { targetCount: 3, acceptedCount: 0, status: "pending" },
    usage: { status: "pending", knownCostMicrousd: 0 },
  });
  journey.complete();
  journey.choose();
  saved = journey.readBatch()!;
  state.session = { status: "ready", userId: ownerId, generation: 1 };
  state.isCurrent
    .mockReset()
    .mockImplementation(
      (account: VerifiedAccount) =>
        state.session.status === "ready" &&
        state.session.userId === account.userId &&
        state.session.generation === account.generation,
    );
  state.identity = {
    client: client(),
    overview: journey.overview(),
    checked: true,
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    strategyDirty: false,
    preferencesDirty: false,
  };
  state.logo = {
    client: createAccountLogoClient(state.session, projectId, state.isCurrent, vi.fn()),
    workspace: journey.workspace,
    status: "ready",
    error: null,
    reload: vi.fn().mockResolvedValue("reloaded"),
    dirty: false,
    pending: false,
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const value of clients) value.dispose();
  state.logo.client?.dispose();
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("saved direction loading for final brand assets", () => {
  it("ends a stalled read after 30 seconds and recovers only through a fresh explicit check", async () => {
    await render();
    expect(reads).toHaveLength(1);
    expect(host.textContent).toContain("Loading your chosen direction…");
    await advance(29_999);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await advance(1);
    expect(reads[0]!.signal.aborted).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("The saved direction took too long to load.");
    await advance(60_000);
    expect(reads).toHaveLength(1);
    await retry();
    expect(reads).toHaveLength(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("Loading your chosen direction…");
    expect(state.identity.refresh).toHaveBeenCalledOnce();
    expect(state.logo.reload).toHaveBeenCalledWith(false);
    await finish(0);
    expect(panel()).toBeNull();
    expect(host.textContent).toContain("Loading your chosen direction…");
    await finish(1);
    expect(panel()?.textContent).toContain(saved.batchId);
    await advance(60_000);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(reads).toHaveLength(2);
  });

  it.each(["failed", "empty"])("clears a %s check error while the explicit retry is loading", async (outcome) => {
    await render();
    if (outcome === "failed") await act(async () => reads[0]!.reject(new Error("Synthetic unavailable read")));
    else await finish(0, null);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("The saved direction could not be checked.");
    await retry();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("Loading your chosen direction…");
    expect(panel()).toBeNull();
    await finish(1);
    expect(panel()).not.toBeNull();
  });

  it("discards a previous batch response and its deadline when the saved selection changes", async () => {
    await render();
    await advance(20_000);
    const nextId = fixtureId(402),
      replace = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(saved.batchId, nextId));
    state.identity.overview = projectIdentityOverviewSchema.parse(replace(state.identity.overview));
    const next = identityBatchStateSchema.parse(replace(saved));
    await render();
    expect(reads[0]!.signal.aborted).toBe(true);
    expect(reads[1]!.batchId).toBe(nextId);
    await finish(0);
    await advance(10_000);
    expect(panel()).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("Loading your chosen direction…");
    await finish(1, next);
    expect(panel()?.textContent).toContain(nextId);
    await advance(60_000);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("ignores a previous client failure after a replacement client has loaded the same batch", async () => {
    await render();
    state.identity.client = client();
    await render();
    expect(reads[0]!.signal.aborted).toBe(true);
    expect(reads).toHaveLength(2);
    await finish(1);
    expect(panel()).not.toBeNull();
    await act(async () => reads[0]!.reject(new Error("Late failure from old client")));
    expect(panel()).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(["checking", "signed_out"] as const)(
    "never publishes a completed private read after the account becomes %s",
    async (status) => {
      await render();
      state.session = { status, generation: 2 };
      // Account authority changes before React gets the next session render.
      await finish(0);
      expect(panel()).toBeNull();
      await render();
      expect(reads[0]!.signal.aborted).toBe(true);
      await advance(60_000);
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(panel()).toBeNull();
    },
  );
});
