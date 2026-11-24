// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceReplyBox } from "@/components/workspace/workspace-reply";

// The side chat's reply box has the same dictation button as the Home prompt.
type Listener = (event: unknown) => void;
class StandInRecognition {
  static last: StandInRecognition | null = null;
  static constructed = 0;
  lang = "";
  continuous = false;
  interimResults = false;
  private listeners = new Map<string, Set<Listener>>();
  constructor() {
    StandInRecognition.last = this;
    StandInRecognition.constructed++;
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: unknown = {}) {
    [...(this.listeners.get(type) ?? [])].forEach((listener) => listener(event));
  }
  start = vi.fn();
  stop = vi.fn(() => this.emit("end"));
  abort = vi.fn();
}
let root: Root | null = null,
  host: HTMLDivElement;
async function mount(props: Partial<Parameters<typeof WorkspaceReplyBox>[0]> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: StandInRecognition });
  StandInRecognition.constructed = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const change = vi.fn(),
    sendText = vi.fn();
  const render = (value: string, extra: Partial<Parameters<typeof WorkspaceReplyBox>[0]> = {}) =>
    act(async () => {
      root!.render(
        createElement(WorkspaceReplyBox, {
          value,
          onChange: change,
          onSendText: sendText,
          action: null,
          ...props,
          ...extra,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  await render("Make it warmer,");
  return { change, sendText, render, mic: () => host.querySelector<HTMLButtonElement>("button.home-voice-button")! };
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "webkitSpeechRecognition");
});

it("dictates into the reply with one press, before Send, and never sends by itself", async () => {
  const f = await mount();
  const buttons = [...host.querySelectorAll(".e-composer__actions button")].map((button) =>
    button.getAttribute("aria-label"),
  );
  expect(buttons).toEqual(["Dictate your prompt", "Send prompt"]);
  // Nothing of the browser's speech system is touched before the press.
  expect(StandInRecognition.constructed).toBe(0);
  await act(async () => {
    f.mic().click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const speech = StandInRecognition.last!;
  expect(speech.start).toHaveBeenCalledOnce();
  expect(speech.continuous).toBe(true);
  await act(async () => speech.emit("start"));
  expect(f.mic().getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector('[role="status"]')?.textContent).toContain("Listening");
  await act(async () =>
    speech.emit("result", { resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "with rounder letters" } }] }),
  );
  expect(f.change).toHaveBeenLastCalledWith("Make it warmer, with rounder letters");
  await act(async () => f.mic().click());
  expect(speech.stop).toHaveBeenCalledOnce();
  expect(f.mic().getAttribute("aria-pressed")).toBe("false");
  expect(f.sendText).not.toHaveBeenCalled();
});

it("is off while a message is being saved or Embel works", async () => {
  const f = await mount();
  await f.render("Kept", { readOnly: true });
  expect(f.mic().disabled).toBe(true);
  await f.render("Kept", { readOnly: false, action: { label: "Continue", working: { label: "Stop response" } } });
  expect(f.mic().disabled).toBe(true);
  expect(StandInRecognition.constructed).toBe(0);
});
