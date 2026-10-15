// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), read: vi.fn(), check: vi.fn(), record: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => mocks.session() }));
vi.mock("@/components/naming/project-screening-client", () => ({ createProjectScreeningClient: () => ({ read: mocks.read, check: mocks.check, record: mocks.record }) }));
import { ProjectScreeningEvidence, projectScreeningLiveNotes } from "@/components/naming/project-screening-evidence";
import { createProjectScreeningMemory } from "@/components/naming/project-screening-memory";
import { AccountRequestError } from "@/components/workspace/account-api";
import { screeningBasis, screeningInput, screeningOwner, screeningPage, screeningProject, screeningRecord, screeningSelection } from "../fixtures/project-screening";
let root: Root, host: HTMLDivElement, memory: ReturnType<typeof createProjectScreeningMemory>;
const account = { status: "ready" as const, userId: screeningOwner, generation: 1 };
const props = { projectId: screeningProject, selectionId: screeningSelection, projectRevision: 2, name: "Cedar" };
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent?.trim() === label)!;
async function fill(label: string, value: string) {
  const element = [...host.querySelectorAll("label")].find(row => row.textContent?.startsWith(label))!.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  memory = createProjectScreeningMemory(); memory.bind(account);
  mocks.session.mockReturnValue({ session: account, isCurrent: () => true, expire: vi.fn(), screeningDrafts: memory });
  mocks.read.mockResolvedValue(screeningPage); mocks.check.mockResolvedValue({ basis: screeningBasis, criteria: screeningInput.criteria, result: { status: "failed", code: "unavailable", retryAfterSeconds: null }, completedAt: screeningInput.observedAt });
  mocks.record.mockImplementation(async input => {
    const record = { ...screeningRecord, requestId: input.requestId, notes: input.notes, sourceUrls: input.sourceUrls, observedAt: input.observedAt, recordedAt: new Date().toISOString() };
    mocks.read.mockResolvedValue({ ...screeningPage, records: [record] }); return record;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
describe("project screening reviewed notes UI", () => {
  it("works through StrictMode effect recovery and requires explicit review before recording", async () => {
    await act(async () => root.render(<StrictMode><ProjectScreeningEvidence {...props} /></StrictMode>));
    await act(async () => button("Run live lookup").click()); expect(mocks.check).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("This provider is not connected."); expect(mocks.record).not.toHaveBeenCalled();
    await act(async () => button("Use this result in my notes").click());
    expect(button("Record reviewed notes").disabled).toBe(true); expect(memory.hasUnsaved()).toBe(true);
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => button("Record reviewed notes").click());
    expect(mocks.record).toHaveBeenCalledOnce(); const input = mocks.record.mock.calls[0]![0];
    expect(input).toMatchObject({ selectionId: screeningSelection, expectedProjectRevision: 2, criteria: screeningInput.criteria, acknowledged: true });
    expect(input).not.toHaveProperty("result"); expect(input).not.toHaveProperty("verification");
    expect(host.textContent).toContain("User-recorded · Unverified"); expect(memory.hasUnsaved()).toBe(false);
  });
  it("records manual research without activating a provider and preserves exact uncertain-save retry", async () => {
    await act(async () => root.render(<ProjectScreeningEvidence {...props} />));
    await fill("Findings and limitations", "I reviewed the official source. This is not clearance.");
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    mocks.record.mockRejectedValueOnce(new AccountRequestError(408));
    await act(async () => button("Record reviewed notes").click());
    const intent = mocks.record.mock.calls[0]![0]; expect(memory.hasUnsaved()).toBe(true); expect(button("Record reviewed notes").disabled).toBe(true);
    await act(async () => button("Retry same record").click());
    expect(mocks.record.mock.calls[1]![0]).toEqual(intent); expect(mocks.check).not.toHaveBeenCalled(); expect(memory.hasUnsaved()).toBe(false);
  });
  it("clears transient observations on criteria change and cancels a lookup when selection changes", async () => {
    await act(async () => root.render(<ProjectScreeningEvidence {...props} />));
    await act(async () => button("Run live lookup").click()); expect(host.querySelector('[aria-label="Temporary live result"]')).not.toBeNull();
    await fill("Exact domain", "cedar.ca"); expect(host.querySelector('[aria-label="Temporary live result"]')).toBeNull();
    let resolve!: (value: unknown) => void;
    mocks.check.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await act(async () => button("Run live lookup").click());
    const signal = mocks.check.mock.calls[1]![1] as AbortSignal;
    await act(async () => root.render(<ProjectScreeningEvidence {...props} selectionId={screeningRecord.id} />)); expect(signal.aborted).toBe(true);
    await act(async () => resolve({ basis: screeningBasis, criteria: screeningInput.criteria, result: { status: "failed", code: "unavailable", retryAfterSeconds: null }, completedAt: screeningInput.observedAt }));
    expect(host.querySelector('[aria-label="Temporary live result"]')).toBeNull();
  });
  it("does not publish a cancelled lookup even if transport ignores its abort", async () => {
    let resolve!: (value: unknown) => void;
    mocks.check.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await act(async () => root.render(<ProjectScreeningEvidence {...props} />));
    await act(async () => button("Run live lookup").click());
    await act(async () => button("Cancel lookup").click());
    expect((mocks.check.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
    await act(async () => resolve({ basis: screeningBasis, criteria: screeningInput.criteria, result: { status: "failed", code: "unavailable", retryAfterSeconds: null }, completedAt: screeningInput.observedAt }));
    expect(host.querySelector('[aria-label="Temporary live result"]')).toBeNull(); expect(mocks.record).not.toHaveBeenCalled();
  });
  it("shows earlier context as history and never labels stale domain observations currently available", async () => {
    mocks.read.mockResolvedValue({ ...screeningPage, projectRevision: 3, currentBasis: { ...screeningBasis, projectRevision: 3 }, records: [screeningRecord] });
    await act(async () => root.render(<ProjectScreeningEvidence {...props} projectRevision={3} />)); expect(host.textContent).toContain("Earlier name or context");
    const notes = projectScreeningLiveNotes({ basis: screeningBasis, criteria: screeningInput.criteria, completedAt: screeningRecord.recordedAt, result: { status: "domain", quote: null, check: { id: "fixture", domain: "cedar.com", provider: "cloudflare_registrar", availability: "available", checkedAt: screeningInput.observedAt, validUntil: screeningRecord.recordedAt, evidenceReference: "fixture" } } }, Date.parse(screeningRecord.recordedAt) + 1);
    expect(notes.text).toContain("current availability unknown"); expect(notes.text).toContain("expired");
  });
  it("keeps an earlier unsaved review visible without applying it to a different selection", async () => {
    memory.put(account, screeningProject, screeningRecord.id, 1, { tool: "domains", domain: "old.com", handle: "old", platform: "youtube", jurisdictions: "EM", niceClasses: "", notes: "Private earlier-context notes", sources: "", observedAt: screeningInput.observedAt, dirty: true, acknowledged: false, pendingInput: null });
    await act(async () => root.render(<ProjectScreeningEvidence {...props} />));
    expect(host.textContent).toContain("Private earlier-context notes");
    const currentNotes = [...host.querySelectorAll("label")].find(row => row.textContent?.startsWith("Findings and limitations"))!.querySelector("textarea")!;
    expect(currentNotes.value).toBe(""); expect(mocks.record).not.toHaveBeenCalled();
    await act(async () => button("Discard earlier draft").click()); expect(memory.hasUnsaved()).toBe(false);
  });
});
