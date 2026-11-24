// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceReplyBox } from "@/components/workspace/workspace-reply";
import { PROPOSED_HOME_ATTACHMENT_POLICY, type DraftAttachment } from "@/domain/attachments";
import type { ChatAttachments } from "@/features/home-inputs/use-chat-attachments";

// The side chat's reply box with the attach button: files are added to the brand and read before the
// typed message goes out, and files alone never move a step forward.
const file = (name: string): DraftAttachment => ({
  localId: `11111111-1111-4111-8111-${String(name.length).padStart(12, "0")}`,
  name,
  mimeType: "text/plain",
  byteLength: 5,
  state: "local",
  ownedRef: null,
});
const attachments = (over: Partial<ChatAttachments> = {}): ChatAttachments => ({
  files: [],
  policy: PROPOSED_HOME_ATTACHMENT_POLICY,
  availability: { status: "available" },
  busy: false,
  status: null,
  error: null,
  revision: 0,
  reading: false,
  add: vi.fn(async () => undefined),
  remove: vi.fn(),
  flush: vi.fn(async () => true),
  ...over,
});
let root: Root | null = null,
  host: HTMLDivElement;
async function mount(props: Partial<Parameters<typeof WorkspaceReplyBox>[0]>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const sendText = vi.fn(() => true),
    change = vi.fn();
  await act(async () =>
    root!.render(
      createElement(WorkspaceReplyBox, { value: "", onChange: change, onSendText: sendText, action: null, ...props }),
    ),
  );
  const send = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const submit = () =>
    act(async () => {
      send().click();
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  return { sendText, change, send, submit };
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("shows the attach button first in the row and no chips until a file is chosen", async () => {
  await mount({ attach: attachments() });
  expect(
    [...host.querySelectorAll(".e-composer__actions button")].map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Add files or images", "Dictate your prompt", "Send prompt"]);
  expect(host.querySelector(".home-attachment-chips")).toBeNull();
  expect(host.querySelector<HTMLInputElement>('input[type="file"]')!.hidden).toBe(true);
});

it("adds and reads the files first, then sends the typed message", async () => {
  const order: string[] = [];
  const attach = attachments({
    files: [file("notes.txt")],
    flush: vi.fn(async () => {
      order.push("files");
      return true;
    }),
  });
  const f = await mount({ attach, value: "Here are my notes" });
  f.sendText.mockImplementation(() => {
    order.push("message");
    return true;
  });
  expect(host.querySelector(".home-attachment-chips")?.textContent).toContain("notes.txt");
  await f.submit();
  expect(order).toEqual(["files", "message"]);
});

it("keeps the message when the files could not be added", async () => {
  const attach = attachments({ files: [file("notes.txt")], flush: vi.fn(async () => false) });
  const f = await mount({ attach, value: "Here are my notes" });
  await f.submit();
  expect(attach.flush).toHaveBeenCalledOnce();
  expect(f.sendText).not.toHaveBeenCalled();
});

it("sends files alone, and never moves the step forward with them", async () => {
  const onSend = vi.fn();
  const attach = attachments({ files: [file("notes.txt")] });
  const f = await mount({ attach, action: { label: "Continue to Audience", onSend } });
  // With files waiting the button is Send, not the step's Continue.
  expect(f.send().getAttribute("aria-label")).toBe("Send prompt");
  expect(f.send().disabled).toBe(false);
  await f.submit();
  expect(attach.flush).toHaveBeenCalledOnce();
  expect(onSend).not.toHaveBeenCalled();
  expect(f.sendText).not.toHaveBeenCalled();
});

it("holds everything while files are being added or read, and says what is happening", async () => {
  const attach = attachments({ files: [file("notes.txt")], busy: true, status: "Embel is reading your files…" });
  const f = await mount({ attach, value: "Kept" });
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Embel is reading your files…");
  expect(f.send().disabled).toBe(true);
  expect(host.querySelector<HTMLTextAreaElement>("textarea")!.readOnly).toBe(true);
  expect(host.querySelector<HTMLButtonElement>("button.home-attach-button")!.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>(".home-attachment-remove")!.disabled).toBe(true);
  await f.submit();
  expect(attach.flush).not.toHaveBeenCalled();
});

it("says why when the brand is full, and shows an upload problem", async () => {
  const attach = attachments({
    policy: null,
    availability: { status: "unavailable", reason: "This brand already has 5 files, the most it can hold." },
    error: "notes.txt couldn’t be uploaded. Your message is kept; send again to retry.",
  });
  await mount({ attach });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("couldn’t be uploaded");
  await act(async () => host.querySelector<HTMLButtonElement>("button.home-attach-button")!.click());
  expect(host.querySelector('.home-input-controls [role="status"]')?.textContent).toBe(
    "This brand already has 5 files, the most it can hold.",
  );
});
