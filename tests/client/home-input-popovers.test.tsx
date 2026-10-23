// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HomeInputControls } from "@/features/home-inputs/home-input-controls";
import { createHomeInputSession } from "@/features/home-inputs/home-input-session";

let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); vi.unstubAllGlobals(); });
it("dismisses attachments with Escape from the prompt or an outside pointer without replacing inputs or changing the prompt", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const change = vi.fn(), start = vi.fn(), availability = vi.fn(async () => ({ status: "unavailable" as const, reason: "Synthetic voice unavailable" }));
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<><textarea aria-label="Prompt" defaultValue="Keep my typed prompt" /><HomeInputControls account={null} sessionFence="signed-out:1" memory={createHomeInputSession()} value="Keep my typed prompt" onChange={change} language="en-US" voiceAdapter={{ availability, start }} policy={null} availability={{ status: "unavailable", reason: "Synthetic storage unavailable" }} disabled={false} compact /></>));
  const files = host.querySelector<HTMLDetailsElement>(".home-files-popover")!, trigger = files.querySelector<HTMLElement>("summary")!, picker = files.querySelector("input"), prompt = host.querySelector("textarea")!;
  await act(async () => trigger.click()); expect(files.open).toBe(true);
  expect(files.querySelector<HTMLInputElement>("input")!.disabled).toBe(true); expect(files.querySelector<HTMLInputElement>("input")!.hidden).toBe(true);
  expect(files.querySelector('[role="status"]')?.textContent).toContain("keep writing your prompt");
  expect(files.querySelector<HTMLDialogElement>(".home-attachment-details dialog")!.open).toBe(false);
  prompt.focus(); await act(async () => prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(files.open).toBe(false); expect(document.activeElement).toBe(trigger); expect(prompt.value).toBe("Keep my typed prompt");
  await act(async () => trigger.click()); expect(files.open).toBe(true);
  await act(async () => prompt.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  expect(files.open).toBe(false); expect(files.querySelector("input")).toBe(picker);
  await act(async () => trigger.click()); await act(async () => trigger.click()); expect(files.open).toBe(false);
  expect(change).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(availability).not.toHaveBeenCalled();
});

it("opening a second native input popover dismisses the first and keeps voice controls mounted", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const memory = createHomeInputSession(), host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const adapter = { availability: vi.fn(async () => ({ status: "unavailable" as const, reason: "Synthetic voice unavailable" })), start: vi.fn() };
  await act(async () => root!.render(<HomeInputControls account={null} sessionFence="signed-out:1" memory={memory} value="Kept" onChange={vi.fn()} language="en-US" voiceAdapter={adapter} policy={null} availability={{ status: "unavailable", reason: "Synthetic unavailable" }} disabled={false} />));
  const files = host.querySelector<HTMLDetailsElement>(".home-files-popover")!, voice = host.querySelector<HTMLDetailsElement>(".home-voice-popover")!;
  expect(voice.querySelector("section")).toBeNull(); expect(adapter.availability).not.toHaveBeenCalled();
  await act(async () => files.querySelector("summary")!.click());
  await act(async () => { voice.querySelector("summary")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); voice.querySelector("summary")!.click(); });
  expect(files.open).toBe(false); expect(voice.open).toBe(true);
  const voiceContent = voice.querySelector("section"); expect(voiceContent).not.toBeNull();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(voice.open).toBe(false); expect(voice.querySelector("section")).toBe(voiceContent); expect(document.activeElement).toBe(voice.querySelector("summary")); expect(adapter.start).not.toHaveBeenCalled();
});

it("probes voice only after explicit activation and resets that intent for a new session", async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const memory = createHomeInputSession(), change = vi.fn();
  const adapter = { availability: vi.fn(async () => ({ status: "unavailable" as const, reason: "Synthetic unavailable" })), start: vi.fn() };
  async function render(fence: string, value = "Typed prompt") {
    await act(async () => root!.render(<HomeInputControls account={null} sessionFence={fence} memory={memory} value={value} onChange={change} language="en-US" voiceAdapter={adapter} policy={null} availability={{ status: "unavailable", reason: "No files" }} disabled={false} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  }
  try {
    await render("session:1"); await render("session:1", "More typed words");
    await act(async () => host.querySelector<HTMLElement>(".home-files-popover summary")!.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(adapter.availability).not.toHaveBeenCalled(); expect(adapter.start).not.toHaveBeenCalled();
    const voice = host.querySelector<HTMLDetailsElement>(".home-voice-popover")!;
    await act(async () => voice.querySelector<HTMLElement>("summary")!.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(adapter.availability).toHaveBeenCalledTimes(1);
    const content = voice.querySelector("section"); expect(content).not.toBeNull();
    await act(async () => voice.querySelector<HTMLElement>("summary")!.click());
    await act(async () => voice.querySelector<HTMLElement>("summary")!.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(voice.querySelector("section")).toBe(content); expect(adapter.availability).toHaveBeenCalledTimes(1);
    await render("session:2");
    expect(host.querySelector<HTMLDetailsElement>(".home-voice-popover")!.open).toBe(false);
    expect(host.querySelector(".home-voice-popover section")).toBeNull();
    expect(adapter.availability).toHaveBeenCalledTimes(1); expect(adapter.start).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
