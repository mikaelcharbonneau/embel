// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { stepReplyAction, WorkspaceReplyBox } from "@/components/workspace/workspace-reply";
import type { StepReply } from "@/features/logo-creation/model/step-reply";

// Stop asked, run still working: the reply box says so and does not offer Stop again (docs/state-machines.md).
const reply = (over: Partial<StepReply>): StepReply => ({
  step: "logo",
  chips: [],
  placeholder: "",
  sendLabel: "Draw six concepts",
  canSend: false,
  acceptsText: false,
  outOfCredits: false,
  working: true,
  stopLabel: "Stop drawing",
  send: vi.fn(),
  stop: vi.fn(),
  ...over,
});

it("passes a step's stopping state to the reply box", () => {
  expect(stepReplyAction(reply({})).working).toMatchObject({ label: "Stop drawing", stopping: false });
  expect(stepReplyAction(reply({ stopping: true })).working).toMatchObject({ label: "Stop drawing", stopping: true });
});

it("shows Stopping… in Stop's place and ignores another press", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"),
    root = createRoot(host);
  document.body.append(host);
  const stopping = reply({ stopping: true });
  try {
    await act(async () =>
      root.render(
        createElement(WorkspaceReplyBox, { value: "", onChange: vi.fn(), action: stepReplyAction(stopping) }),
      ),
    );
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Stopping…"]');
    expect(button).not.toBeNull();
    expect(button!.getAttribute("aria-disabled")).toBe("true");
    expect(host.querySelector('button[aria-label="Stop drawing"]')).toBeNull();
    await act(async () => button!.click());
    expect(stopping.stop).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
