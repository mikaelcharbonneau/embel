// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectIdentityWorkspace } from "@/components/identity/project-identity";
import type { ProjectIdentityController } from "@/components/identity/use-project-identity";
import { identityColorForm, identityPreferenceForm, identityTypographyForm } from "@/components/identity/identity-draft-memory";
import { fixtureInput, fixtureOverview, fixtureProject, fixtureSystem } from "./project-identity-fixtures";

const hooks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/components/identity/use-project-identity", () => ({ useProjectIdentity: () => hooks.read() }));
vi.mock("@/components/identity/account-identity-client", () => ({ identitySystemFreshness: () => ({ status: "stale", changed: ["strategy"] }) }));
vi.mock("@/components/identity/identity-system-board", async original => ({ ...await original<typeof import("@/components/identity/identity-system-board")>(), IdentitySystemBoard: () => null, IdentityProductionFiles: () => null }));
let host: HTMLDivElement, root: Root, controller: ProjectIdentityController;
const save = vi.fn();
async function render() { hooks.read.mockReturnValue(controller); await act(async () => root.render(<ProjectIdentityWorkspace projectId={fixtureProject} />)); }
function button(container: Element, text: string) { return [...container.querySelectorAll("button")].find(node => node.textContent?.replace("↗", "").trim() === text)!; }
async function open(title: string) { await act(async () => button(host, title).click()); return host.querySelector<HTMLDialogElement>("dialog[open]")!; }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); save.mockReset();
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } },
  });
  const input = fixtureInput(), system = fixtureSystem(input), overview = fixtureOverview({ systems: [system], selected: true });
  const scope = { ownerId: input.ownerId, projectId: fixtureProject };
  controller = {
    verified: { userId: input.ownerId, generation: 1 }, client: { current: () => true }, overview, system, items: [], nextCursor: null,
    loading: false, pending: false, checked: true, blocked: false, retained: [], fence: "original", error: null, notice: null,
    preferenceValues: identityPreferenceForm(input.preferences), preferenceDraft: { kind: "preferences", ...scope, baselineRevision: 0, baseline: input.preferences, value: identityPreferenceForm(input.preferences), pending: null },
    colors: { kind: "component", ...scope, baseSystemVersionId: system.id, component: "colors", baseline: system.components.colors, value: { ...identityColorForm(system.components.colors), usageNotes: "Changed locally" }, pending: null },
    typography: { kind: "component", ...scope, baseSystemVersionId: system.id, component: "typography", baseline: system.components.typography, value: { ...identityTypographyForm(system.components.typography), usageNotes: "Changed locally" }, pending: null },
    saveComponent: save, savePreferences: save, refresh: vi.fn(),
  } as unknown as ProjectIdentityController;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close"); });

it.each(["colors", "typography"] as const)("allows explicit earlier-input approval inside %s and resets it on a new fence", async component => {
  await render(); const dialog = await open(`Edit ${component}`);
  const approve = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const submit = button(dialog, `Save ${component} as new version`);
  expect(approve.checked).toBe(false); expect(submit.disabled).toBe(true);
  expect(dialog.textContent).toContain("Earlier inputs: Strategy");
  await act(async () => approve.click()); expect(submit.disabled).toBe(false);
  expect(dialog.open).toBe(true); expect(save).not.toHaveBeenCalled();
  await act(async () => dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(save).toHaveBeenCalledExactlyOnceWith(component, true);
  controller = { ...controller, fence: "independent-revision" }; await render();
  expect(host.querySelector("dialog[open]")).toBe(dialog); expect(approve.checked).toBe(false); expect(submit.disabled).toBe(true);
});
it.each(["Edit colors", "Edit typography", "Identity preferences"])("publishes save errors and results inside %s without closing it", async title => {
  await render(); const dialog = await open(title);
  controller = { ...controller, error: "Saved inputs changed. Your edits are kept.", notice: null }; await render();
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(controller.error);
  controller = { ...controller, error: null, notice: "Saved successfully in history." }; await render();
  expect(dialog.querySelector('[role="alert"]')).toBeNull();
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe(controller.notice);
  expect(dialog.open).toBe(true); expect(save).not.toHaveBeenCalled();
});
it.each(["loading", "pending", "referencesPending"] as const)("cannot acknowledge stale inputs during %s", async state => {
  controller = { ...controller, [state]: true }; await render(); const dialog = await open("Edit colors");
  const approve = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(approve.disabled).toBe(true); await act(async () => approve.click());
  expect(approve.checked).toBe(false); expect(button(dialog, "Save colors as new version").disabled).toBe(true);
  expect(save).not.toHaveBeenCalled();
});

it("checks a failed save from the open editor without submitting or changing its draft", async () => {
  controller = { ...controller, error: "Saved inputs changed. Your edits are kept." };
  await render(); const dialog = await open("Edit colors"), field = dialog.querySelector('input[aria-label="Color 1 name"]');
  await act(async () => button(dialog, "Check latest saved inputs").click());
  expect(controller.refresh).toHaveBeenCalledOnce(); expect(dialog.open).toBe(true);
  expect(dialog.querySelector('input[aria-label="Color 1 name"]')).toBe(field); expect(save).not.toHaveBeenCalled();
});

it("reveals a new response once in the active modal without stealing input focus", async () => {
  await render(); const dialog = await open("Edit colors"), field = dialog.querySelector<HTMLInputElement>('input[aria-label="Color 1 name"]')!;
  const scroll = vi.fn(); dialog.scrollTo = scroll; field.focus();
  controller = { ...controller, notice: "New saved result" }; await render();
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: "instant" }); expect(document.activeElement).toBe(field);
  controller = { ...controller }; await render(); expect(scroll).toHaveBeenCalledTimes(1);
  await act(async () => button(dialog, "Close").click());
  controller = { ...controller, notice: "Another background result" }; await render(); expect(scroll).toHaveBeenCalledTimes(1);
});
