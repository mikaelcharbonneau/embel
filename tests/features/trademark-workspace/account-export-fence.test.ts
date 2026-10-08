import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrademarkAccountEditor } from "@/components/tools/trademark-account-editor";
import { createStandaloneDraftMemory } from "@/components/tools/standalone-draft-memory";
import type { TrademarkWorkspaceProps } from "@/features/trademark-workspace/trademark-workspace";
import * as trademarkDomain from "@/features/trademark-workspace/domain";

type ReadyAccount = { status: "ready"; userId: string; generation: number };
type FixtureSession = ReadyAccount | { status: "checking"; generation: number };
const fixture = vi.hoisted(() => ({
  session: { status: "checking", generation: 0 } as FixtureSession,
  workspace: {} as Record<string, unknown>,
  callback: null as TrademarkWorkspaceProps["onExportPreview"] | null,
}));

vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({
    session: fixture.session,
    isCurrent: (account: ReadyAccount) => fixture.session.status === "ready" && fixture.session.userId === account.userId && fixture.session.generation === account.generation,
  }),
  AccountStatus: () => null,
}));
vi.mock("@/components/tools/use-standalone-workspace", () => ({ useStandaloneWorkspace: () => fixture.workspace }));
vi.mock("@/features/trademark-workspace/trademark-workspace", () => ({
  TrademarkWorkspace: (props: TrademarkWorkspaceProps) => { fixture.callback = props.onExportPreview; return null; },
}));

const ownerA = "00000000-0000-4000-8000-00000000000a";
const ownerB = "00000000-0000-4000-8000-00000000000b";
const RealBlob = Blob;
const blobConstructor = vi.fn(function (parts: BlobPart[], options: BlobPropertyBag) { return new RealBlob(parts, options); });
const createUrl = vi.fn(() => "blob:trademark-fixture");
const revokeUrl = vi.fn();
const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
const createElementSpy = vi.fn(() => anchor);
const appendChild = vi.fn();

beforeEach(() => {
  vi.clearAllMocks(); fixture.callback = null;
  anchor.href = ""; anchor.download = "";
  vi.stubGlobal("Blob", blobConstructor);
  vi.stubGlobal("document", { createElement: createElementSpy, body: { appendChild } });
  vi.spyOn(URL, "createObjectURL").mockImplementation(createUrl);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeUrl);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function captureExport() {
  const account: ReadyAccount = { status: "ready", userId: ownerA, generation: 1 };
  const memory = createStandaloneDraftMemory(); memory.bind(account);
  const draft = trademarkDomain.confirmTrademarkReview({ ...trademarkDomain.createTrademarkDraft("Private fixture mark"),
    owner: { name: "Owner A fixture", address: "Private fixture address", contact: "Private fixture contact" }, userNotes: 'User note with "quotes" and a newline\nkept exactly.' });
  const record = { workspace: null, payload: draft, imports: [], dirty: true, pending: null, conflict: false };
  memory.set(account, "trademarks", record);
  fixture.session = account;
  fixture.workspace = { ...record, canEdit: true, canSave: true, pending: false, busy: false, error: null, status: "ready" };
  renderToStaticMarkup(createElement(TrademarkAccountEditor, { memory }));
  const callback = fixture.callback;
  if (!callback) throw new Error("The real account editor did not supply its export callback.");
  return { account, memory, callback, preview: trademarkDomain.buildTrademarkDraftPreview(draft) };
}

function expectNoPrivateExport(serialize: ReturnType<typeof vi.spyOn>) {
  expect(serialize).not.toHaveBeenCalled();
  expect(blobConstructor).not.toHaveBeenCalled();
  expect(createUrl).not.toHaveBeenCalled();
  expect(createElementSpy).not.toHaveBeenCalled();
  expect(appendChild).not.toHaveBeenCalled();
  expect(anchor.click).not.toHaveBeenCalled();
  expect(revokeUrl).not.toHaveBeenCalled();
}

describe("Trademark account export invocation fencing (real callback; synthetic session/DOM)", () => {
  it.each(["checking", "same-owner-new-generation", "other-owner"] as const)("blocks a retained callback after synchronous %s invalidation", scenario => {
    const { callback, preview, account, memory } = captureExport();
    fixture.session = scenario === "checking" ? { status: "checking", generation: 2 } :
      { ...account, userId: scenario === "other-owner" ? ownerB : ownerA, generation: 2 };
    memory.bind(fixture.session.status === "ready" ? fixture.session : null);
    expect(memory.isCurrent(account)).toBe(false);
    const serialize = vi.spyOn(trademarkDomain, "serializeTrademarkDraftPreview");
    callback(preview);
    expectNoPrivateExport(serialize);
  });

  it("requires the current session even while the memory fence still matches the captured account", () => {
    const { callback, preview, account, memory } = captureExport();
    fixture.session = { ...account, generation: 2 };
    expect(memory.isCurrent(account)).toBe(true);
    const serialize = vi.spyOn(trademarkDomain, "serializeTrademarkDraftPreview");
    callback(preview);
    expectNoPrivateExport(serialize);
  });

  it("requires the current memory binding even while the verified session still matches", () => {
    const { callback, preview, account, memory } = captureExport();
    memory.bind(null);
    expect(fixture.session).toBe(account);
    const serialize = vi.spyOn(trademarkDomain, "serializeTrademarkDraftPreview");
    callback(preview);
    expectNoPrivateExport(serialize);
  });

  it("exports the exact honest JSON preview for the still-current verified owner and releases the URL", async () => {
    const { callback, preview, account, memory } = captureExport();
    expect(memory.isCurrent(account)).toBe(true);
    const expected = JSON.stringify(trademarkDomain.buildTrademarkDraftPreview(preview.draft), null, 2);
    const serialize = vi.spyOn(trademarkDomain, "serializeTrademarkDraftPreview");
    callback(preview);
    expect(serialize).toHaveBeenCalledExactlyOnceWith(preview);
    expect(blobConstructor).toHaveBeenCalledExactlyOnceWith([expected], { type: "application/json" });
    const blob = blobConstructor.mock.results[0]!.value as Blob;
    expect(await blob.text()).toBe(expected);
    expect(JSON.parse(await blob.text())).toMatchObject({
      label: "Draft preview — not a filing dossier", inputOrigin: "user-entered",
      draft: { owner: preview.draft.owner, reviewedContent: preview.draft.reviewedContent }, research: { status: "unavailable", matches: [] },
    });
    expect(createUrl).toHaveBeenCalledExactlyOnceWith(blob);
    expect(createElementSpy).toHaveBeenCalledExactlyOnceWith("a");
    expect(anchor.href).toBe("blob:trademark-fixture");
    expect(anchor.download).toBe("fluid-trademark-draft-preview.json");
    expect(appendChild).toHaveBeenCalledExactlyOnceWith(anchor);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:trademark-fixture");
  });
});
