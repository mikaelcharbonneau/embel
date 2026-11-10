import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogoInputSession, emptyLogoInputDraft } from "@/features/logo-inputs/client/session";
import type { LogoInputClient } from "@/features/logo-inputs/client/controller";
import { syntheticLogoWorkspace, logoFixtureId as id } from "../../fixtures/logo-creation";
import type { VerifiedAccount } from "@/components/workspace/account-session";
function fixture() {
  vi.stubGlobal("crypto", webcrypto);
  const base = syntheticLogoWorkspace(),
    workspace = { ...base, capabilities: { ...base.capabilities, upload: { status: "available" as const } } };
  const account = { status: "ready", userId: workspace.ownerId, generation: 2 } as VerifiedAccount;
  const session = createLogoInputSession();
  session.bind(account);
  const requests: unknown[] = [];
  const client = {
    uploadLogoReference: async (input: unknown) => {
      requests.push(input);
      throw Error("Lost connection");
    },
    readLogoInputRequest: async () => ({ status: "not_found" }),
  } as unknown as LogoInputClient;
  const controller = session.connect(account, workspace, client, true)!;
  const file = new File([new Uint8Array([1, 2, 3])], "owned.png", { type: "image/png" });
  return { session, account, workspace, controller, client, requests, file };
}
afterEach(() => vi.unstubAllGlobals());
describe("provider-lifetime owner-bound input session", () => {
  it("retains an uncertain request and its file across view replacement without a singleton", async () => {
    const f = fixture();
    await f.controller.uploadReference(f.file, ["shape"], true);
    expect(f.session.hasUnsaved()).toBe(true);
    const pending = f.controller.getSnapshot().pending;
    const reattached = f.session.connect(f.account, f.workspace, f.client, true)!;
    expect(reattached).toBe(f.controller);
    expect(reattached.getSnapshot().pending).toEqual(pending);
    expect(reattached.getSnapshot().hasOriginalFile).toBe(true);
    expect(createLogoInputSession().hasUnsaved()).toBe(false);
    expect(f.requests).toHaveLength(1);
  });
  it("stores local file selections synchronously and hides them while identity is unverified", () => {
    const f = fixture(),
      draft = {
        ...emptyLogoInputDraft(),
        referenceFile: f.file,
        referencePermission: true,
        aspects: ["shape" as const],
      };
    expect(f.session.setDraft(f.account, f.workspace.projectId, draft)).toBe(true);
    expect(f.session.hasUnsaved()).toBe(true);
    expect(f.session.getDraft(f.account, f.workspace.projectId)?.referenceFile).toBe(f.file);
    f.session.bind(null);
    expect(f.session.getDraft(f.account, f.workspace.projectId)).toBeNull();
    expect(f.session.get(f.account, f.workspace.projectId)).toBeNull();
    expect(f.session.hasUnsaved()).toBe(true);
    const again = { ...f.account, generation: 3 };
    f.session.bind(again);
    expect(f.session.connect(again, f.workspace, f.client, true)).toBe(f.controller);
    expect(f.session.getDraft(again, f.workspace.projectId)?.referenceFile).toBe(f.file);
  });
  it("marks an upload as unsaved before async file hashing begins", async () => {
    const f = fixture();
    let release!: (bytes: ArrayBuffer) => void;
    Object.defineProperty(f.file, "arrayBuffer", {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          release = resolve;
        }),
    });
    const work = f.controller.uploadReference(f.file, ["shape"], true);
    expect(f.session.hasUnsaved()).toBe(true);
    release(new Uint8Array([1, 2, 3]).buffer);
    await work;
    expect(f.session.hasUnsaved()).toBe(true);
  });
  it("verified owner change disposes all old form files and never exposes or retries old requests", async () => {
    const f = fixture();
    await f.controller.uploadReference(f.file, ["shape"], true);
    f.session.setDraft(f.account, f.workspace.projectId, {
      ...emptyLogoInputDraft(),
      fontFile: new File([new Uint8Array(12)], "sample.ttf", { type: "font/ttf" }),
      license: "Owned terms",
    });
    f.session.bind({ ...f.account, userId: id(909), generation: 3 });
    expect(f.session.hasUnsaved()).toBe(false);
    expect(f.controller.getSnapshot().pending).toBeNull();
    expect(f.session.get(f.account, f.workspace.projectId)).toBeNull();
    await f.controller.retry();
    expect(f.requests).toHaveLength(1);
  });
  it("same-owner checking aborts late callbacks while retaining a submitted exact request", async () => {
    const f = fixture();
    let release!: () => void;
    const slow = {
      ...f.client,
      uploadLogoReference: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw Error("Late old-generation failure");
      },
    };
    const controller = f.session.connect(f.account, f.workspace, slow, true)!;
    const work = controller.uploadReference(f.file, ["shape"], true);
    for (let n = 0; n < 20 && !release; n++) await new Promise((resolve) => setTimeout(resolve, 2));
    const pending = controller.getSnapshot().pending;
    f.session.bind(null);
    const again = { ...f.account, generation: 3 };
    f.session.bind(again);
    f.session.connect(again, f.workspace, f.client, true);
    release();
    await work;
    expect(controller.getSnapshot().pending).toEqual(pending);
    expect(controller.getSnapshot().busy).toBe(false);
    expect(controller.getSnapshot().error).toBeNull();
    await controller.check();
    expect(controller.getSnapshot().pendingStatus).toBe("not_found");
  });
  it("clear removes tab-local retained bytes after confirmed sign-out", async () => {
    const f = fixture();
    await f.controller.uploadReference(f.file, ["shape"], true);
    f.session.clear();
    expect(f.session.hasUnsaved()).toBe(false);
    expect(f.controller.getSnapshot().pending).toBeNull();
  });
});
