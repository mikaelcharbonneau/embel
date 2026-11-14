// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_WIDTH, forgetChatPreferences, Workspace, useWorkspace } from "@/components/workspace/workspace-layout";
import {
  stepReplyAction,
  useReplyRegistry,
  useWorkspaceReply,
  WorkspaceReplyBox,
  WorkspaceReplyRegistry,
  type WorkspaceReplyAction,
} from "@/components/workspace/workspace-reply";

let host: HTMLDivElement, root: Root, wide: boolean;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  wide = true;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: wide, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  window.localStorage.clear();
  forgetChatPreferences();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function Width() {
  const state = useWorkspace();
  return <span data-width={state?.chatWidth} data-wide={String(state?.wide)} />;
}
async function render(log = "Hello") {
  await act(async () =>
    root.render(<Workspace log={<p>{log}</p>} reply={<p>Reply</p>} work={<Width />} logKey={log} />),
  );
}
const handle = () => host.querySelector<HTMLElement>('[role="separator"]')!;
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.getAttribute("aria-label") === name || item.textContent?.startsWith(name),
  );
async function key(name: string) {
  await act(async () => handle().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
}

describe("Workspace", () => {
  it("puts the chat beside the work at 400 px and resizes it with the keyboard between 320 and 560 px", async () => {
    await render();
    expect(handle().getAttribute("aria-valuenow")).toBe(String(CHAT_WIDTH.initial));
    expect(handle().getAttribute("aria-orientation")).toBe("vertical");
    expect(handle().tabIndex).toBe(0);
    expect(document.documentElement.style.getPropertyValue("--workspace-chat-width")).toBe("400px");
    await key("ArrowRight");
    expect(handle().getAttribute("aria-valuenow")).toBe("416");
    await key("End");
    expect(handle().getAttribute("aria-valuenow")).toBe("560");
    await key("ArrowRight");
    expect(handle().getAttribute("aria-valuenow")).toBe("560");
    await key("Home");
    expect(handle().getAttribute("aria-valuenow")).toBe("320");
    // The work area knows the chat's width, so results can stay three across while it widens.
    expect(host.querySelector("[data-width]")!.getAttribute("data-width")).toBe("320");
    expect(document.documentElement.style.getPropertyValue("--workspace-chat-width")).toBe("320px");
    expect(JSON.parse(window.localStorage.getItem("embel.workspace.chat")!)).toEqual({ width: 320, hidden: false });
  });

  it("hides and shows the chat, keeps its content mounted and remembers it for the browser", async () => {
    await render();
    expect(button("Hide chat")).toBeDefined();
    await act(async () => button("Hide chat")!.click());
    expect(host.querySelector<HTMLElement>('section[aria-label="Chat"]')!.hidden).toBe(true);
    expect(host.textContent).toContain("Hello");
    expect(handle()).toBeNull();
    expect(document.documentElement.dataset.workspace).toBe("hidden");
    expect(document.activeElement).toBe(button("Show chat"));
    // A message that arrives while hidden is marked on Show chat.
    await render("A new message");
    expect(button("Show chat")!.querySelector('[aria-label="New message"]')).not.toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    forgetChatPreferences();
    await render();
    expect(button("Show chat")).toBeDefined();
    await act(async () => button("Show chat")!.click());
    expect(host.querySelector<HTMLElement>('section[aria-label="Chat"]')!.hidden).toBe(false);
    expect(document.documentElement.dataset.workspace).toBe("chat");
  });

  it("keeps working when the browser refuses storage", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await render();
    await key("ArrowLeft");
    expect(handle().getAttribute("aria-valuenow")).toBe("384");
    vi.restoreAllMocks();
  });

  it("is one column below 1024 px: nothing to hide or resize", async () => {
    wide = false;
    await render();
    expect(host.querySelector("[data-wide]")!.getAttribute("data-wide")).toBe("false");
    expect(handle().tabIndex).toBe(-1);
  });
});

function Step({ action }: { action: WorkspaceReplyAction | null }) {
  useWorkspaceReply(action);
  return null;
}
function Harness({ action, fallback }: { action: WorkspaceReplyAction | null; fallback?: WorkspaceReplyAction }) {
  const registry = useReplyRegistry();
  const [value, setValue] = useState("");
  return (
    <WorkspaceReplyRegistry.Provider value={registry.register}>
      <Step action={action} />
      {fallback && <Fallback action={fallback} />}
      <WorkspaceReplyBox
        value={value}
        onChange={setValue}
        onSendText={sendText}
        action={registry.action ?? registry.fallback}
      />
    </WorkspaceReplyRegistry.Provider>
  );
}
function Fallback({ action }: { action: WorkspaceReplyAction }) {
  useWorkspaceReply(action, { fallback: true });
  return null;
}
const sendText = vi.fn();

describe("reply box", () => {
  it("shows a step's chips and moves on with Send when nothing is typed", async () => {
    const onSend = vi.fn();
    await act(async () =>
      root.render(<Harness action={{ chips: ["Logo: Concept 1"], label: "Continue to Creative direction", onSend }} />),
    );
    expect([...host.querySelectorAll(".e-chip")].map((chip) => chip.textContent)).toEqual(["Logo: Concept 1"]);
    const send = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(send.getAttribute("aria-label")).toBe("Continue to Creative direction");
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(onSend).toHaveBeenCalledOnce();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("puts Stop in Send's place while Embel works, and Send stays unavailable with nothing to send", async () => {
    const onStop = vi.fn();
    await act(async () => root.render(<Harness action={{ working: { label: "Stop drawing", onStop } }} />));
    expect(host.querySelector('button[type="submit"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Stop drawing"]')!.click());
    expect(onStop).toHaveBeenCalledOnce();
    await act(async () => root.render(<Harness action={null} />));
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });

  it("prefers a step's action over a fallback and returns to the fallback when the step leaves", async () => {
    const fallback = { label: "Continue to Assets", onSend: vi.fn() };
    await act(async () => root.render(<Harness action={{ label: "Draw six concepts" }} fallback={fallback} />));
    expect(host.querySelector('button[type="submit"]')!.getAttribute("aria-label")).toBe("Draw six concepts");
    await act(async () => root.render(<Harness action={null} fallback={fallback} />));
    expect(host.querySelector('button[type="submit"]')!.getAttribute("aria-label")).toBe("Continue to Assets");
  });

  it("sends typed text to the step's handler and clears it only once the step has taken it", async () => {
    let take: (taken: boolean) => void = () => undefined;
    const onSendText = vi.fn(() => new Promise<boolean>((resolve) => (take = resolve)));
    await act(async () =>
      root.render(<Harness action={{ label: "Continue to Slogan", onSend: vi.fn(), onSendText }} />),
    );
    const textarea = host.querySelector("textarea")!;
    const type = async (text: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await type("Shorter names");
    const send = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(send.getAttribute("aria-label")).toBe("Send prompt");
    await act(async () => send.click());
    expect(onSendText).toHaveBeenCalledWith("Shorter names");
    expect(sendText).not.toHaveBeenCalled();
    await act(async () => take(false));
    expect(textarea.value).toBe("Shorter names");
    await act(async () => send.click());
    await act(async () => take(true));
    expect(textarea.value).toBe("");
  });

  it("maps the Logo and Creative direction steps' external reply onto the reply box", () => {
    const send = vi.fn(),
      stop = vi.fn();
    const base = {
      step: "logo" as const,
      chips: [{ id: "wordmark", label: "Wordmark", onRemove: vi.fn() }],
      placeholder: "Describe a change…",
      sendLabel: "Draw six concepts",
      canSend: true,
      acceptsText: false,
      outOfCredits: false,
      working: false,
      stopLabel: "Stop drawing",
      send,
      stop,
    };
    const action = stepReplyAction(base);
    expect(action.label).toBe("Draw six concepts");
    expect(action.onSendText).toBeUndefined();
    action.onSend!();
    expect(send).toHaveBeenCalledWith("");
    expect(stepReplyAction({ ...base, outOfCredits: true }).onSend).toBeUndefined();
    expect(stepReplyAction({ ...base, outOfCredits: true }).blockedReason).toBeTruthy();
    expect(stepReplyAction({ ...base, working: true }).working).toMatchObject({ label: "Stop drawing" });
  });
});
