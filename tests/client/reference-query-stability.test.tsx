// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import { identityReferencesOverviewSchema, type IdentityReferenceQuery } from "@/domain/identity-references";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { createReferenceIntentMemory, useIdentityReferences } from "@/components/identity/use-identity-references";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const session = vi.hoisted(() => ({ current: null as VerifiedAccount | null, drafts: null as unknown as ReturnType<typeof createAccountDraftMemory>, expire: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({
    drafts: session.drafts,
    isCurrent: (account: VerifiedAccount) => session.current?.userId === account.userId && session.current.generation === account.generation,
    expire: session.expire,
  }),
}));
const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account: VerifiedAccount = { status: "ready", userId: id(1), generation: 1 }, projectId = id(2);
const project = accountProjectSchema.parse({ id: projectId, owner_id: account.userId, title: "Reference fixture", scope: "complete_brand", current_revision: 1, created_at: "2026-10-04T12:00:00Z", context: { description: "Local synthetic reference fixture" } });
function overview(query: IdentityReferenceQuery) {
  return identityReferencesOverviewSchema.parse({
    ownerId: account.userId, projectId, referenceRevision: 0, selectedReferenceCount: 0, query,
    feed: { status: "unavailable", reason: "reference_source_unconfigured" },
    availableTags: ["soft", "warm"], tagsComplete: true,
    references: { items: [{ reference: { id: id(5), ownerId: account.userId, projectId, createdAt: "2026-10-04T12:00:00Z",
      media: { ownerId: account.userId, projectId, assetId: id(3), versionId: id(4), contentHash: "a".repeat(64), purpose: "reference_media", mimeType: "image/png" },
      source: "user_supplied", attribution: { label: "Synthetic reference", creator: null, sourceUrl: null, rightsNote: null }, relevantElements: ["logo"], tags: [] },
    reaction: { ownerId: account.userId, projectId, referenceId: id(5), revision: 0, ensemble: false, elements: [], updatedAt: null } }], nextCursor: null },
  });
}
type Pending = { query: IdentityReferenceQuery; signal: AbortSignal; resolve: (response: Response) => void };
let root: Root, host: HTMLDivElement, references: ReturnType<typeof useIdentityReferences>, memory: ReturnType<typeof createReferenceIntentMemory>;
let reads: IdentityReferenceQuery[], pending: Pending[], hold: boolean;
function Probe() {
  const value = useIdentityReferences(account, projectId, memory);
  useLayoutEffect(() => { references = value; });
  return <div>{value.page?.references.items.map(entry => <article key={entry.reference.id}>{entry.reference.attribution.label}</article>)}</div>;
}
async function mount() { await act(async () => root.render(<Probe />)); }
async function resolve(index: number) { await act(async () => pending[index]!.resolve(Response.json(overview(pending[index]!.query)))); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  session.current = account; session.expire.mockReset(); session.drafts = createAccountDraftMemory();
  memory = createReferenceIntentMemory(); memory.bind(account.userId);
  reads = []; pending = []; hold = false;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn((path: string, options: RequestInit) => {
    if (path === `/api/projects/${projectId}`) return Promise.resolve(Response.json({ project }));
    const url = new URL(path, "https://fixture.invalid");
    expect(url.pathname).toBe(`/api/projects/${projectId}/identity/references`);
    const query = { limit: Number(url.searchParams.get("limit")), excludedTags: url.searchParams.getAll("excludedTag") };
    reads.push(query);
    if (hold) return new Promise<Response>(resolve => pending.push({ query, signal: options.signal!, resolve }));
    return Promise.resolve(Response.json(overview(query)));
  }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("reference query no-op continuity", () => {
  it("keeps a verified page and card when clearing an already empty exclusion set", async () => {
    await mount();
    const page = references.page, query = references.query, card = host.querySelector("article");
    expect(page).not.toBeNull();
    await act(async () => references.changeExclusions([]));
    expect(references.page).toBe(page); expect(references.query).toBe(query);
    expect(host.querySelector("article")).toBe(card); expect(reads).toHaveLength(1);
  });

  it("normalizes exclusion order and whitespace before detecting an unchanged query", async () => {
    await mount();
    await act(async () => references.changeExclusions(["warm", "soft"]));
    const page = references.page, query = references.query, card = host.querySelector("article"), count = reads.length;
    await act(async () => references.changeExclusions([" soft ", "warm"]));
    expect(references.page).toBe(page); expect(references.query).toBe(query);
    expect(host.querySelector("article")).toBe(card); expect(reads).toHaveLength(count);
  });

  it("does not abort a pending refresh for unchanged exclusions", async () => {
    await mount(); const page = references.page; hold = true;
    await act(async () => references.refresh());
    await act(async () => references.changeExclusions([]));
    expect(pending).toHaveLength(1); expect(pending[0]!.signal.aborted).toBe(false);
    expect(references.page).toBe(page);
    await resolve(0); expect(references.loading).toBe(false);
  });

  it("keeps real filter transitions and late-result fencing intact", async () => {
    await mount(); hold = true;
    await act(async () => references.changeExclusions(["warm"]));
    expect(references.page).toBeNull();
    await act(async () => references.changeExclusions(["soft"]));
    expect(pending[0]!.signal.aborted).toBe(true);
    await resolve(1); const current = references.page;
    await resolve(0);
    expect(references.page).toBe(current); expect(references.query.excludedTags).toEqual(["soft"]);
  });

  it("compares to the latest requested exclusions during batched changes", async () => {
    await mount(); hold = true;
    await act(async () => { references.changeExclusions(["warm"]); references.changeExclusions([]); });
    expect(references.query.excludedTags).toEqual([]); expect(references.page).toBeNull();
    expect(pending).toHaveLength(1); await resolve(0);
    expect(references.page?.query.excludedTags).toEqual([]);
  });
});
