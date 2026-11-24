// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { PROPOSED_HOME_ATTACHMENT_POLICY, type AttachmentPolicy } from "@/domain/attachments";
import { HomeAttachmentChips, HomeInputControls } from "@/features/home-inputs/home-input-controls";
import { createHomeInputSession } from "@/features/home-inputs/home-input-session";

// The attach and dictate buttons of the Home prompt box: each acts on one press, with no panel to open first.

const account: VerifiedAccount = { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 };
const policy: AttachmentPolicy = { ...PROPOSED_HOME_ATTACHMENT_POLICY, allowedMimeTypes: ["text/plain", "image/png"] };
const silentVoice = {
  availability: vi.fn(async () => ({ status: "unavailable" as const, reason: "Synthetic voice unavailable" })),
  start: vi.fn(),
};
let root: Root | null = null;
function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", webcrypto);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  return host;
}
const attach = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("button.home-attach-button")!;
const picker = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[type="file"]')!;
async function choose(host: HTMLElement, files: File[]) {
  const input = picker(host);
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
const textFile = (name: string, body = "brief") =>
  new NodeFile([body], name, { type: "text/plain" }) as unknown as File;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  silentVoice.availability.mockClear();
  silentVoice.start.mockClear();
});

it("signed out: the attach button explains that files need an account and offers sign-in, leaving the prompt alone", async () => {
  const host = mount(),
    change = vi.fn(),
    signIn = vi.fn();
  await act(async () =>
    root!.render(
      <HomeInputControls
        account={null}
        sessionFence="signed-out:1"
        memory={createHomeInputSession()}
        value="Keep my typed prompt"
        onChange={change}
        language="en-US"
        voiceAdapter={silentVoice}
        policy={null}
        availability={{ status: "unavailable", reason: "Synthetic storage unavailable" }}
        disabled={false}
        onSignIn={signIn}
      />,
    ),
  );
  expect(attach(host).getAttribute("aria-label")).toBe("Add files or images");
  expect(attach(host).disabled).toBe(false);
  // The raw file field is never shown or reachable; the button stands for it.
  expect(picker(host).hidden).toBe(true);
  expect(picker(host).disabled).toBe(true);
  expect(host.querySelector('[role="status"]')).toBeNull();
  const open = vi.spyOn(picker(host), "click");
  await act(async () => attach(host).click());
  expect(open).not.toHaveBeenCalled();
  const note = host.querySelector('[role="status"]')!;
  expect(note.textContent).toContain("Files can be added once you’re signed in.");
  await act(async () => note.querySelector("button")!.click());
  expect(signIn).toHaveBeenCalledOnce();
  expect(change).not.toHaveBeenCalled();
});

it("signed in without file storage: the attach button gives the reason and no sign-in link", async () => {
  const host = mount(),
    memory = createHomeInputSession();
  memory.bind(account);
  await act(async () =>
    root!.render(
      <HomeInputControls
        account={account}
        sessionFence="owner:1"
        memory={memory}
        value=""
        onChange={vi.fn()}
        language="en-US"
        voiceAdapter={silentVoice}
        policy={null}
        availability={{ status: "unavailable", reason: "Files can’t be added right now." }}
        disabled={false}
        onSignIn={vi.fn()}
      />,
    ),
  );
  await act(async () => attach(host).click());
  const note = host.querySelector('[role="status"]')!;
  expect(note.textContent).toBe("Files can’t be added right now.");
  expect(note.querySelector("button")).toBeNull();
});

it("one press opens the file chooser; chosen files show as chips that can be removed", async () => {
  const host = mount(),
    memory = createHomeInputSession();
  memory.bind(account);
  await act(async () =>
    root!.render(
      <>
        <HomeAttachmentChips account={account} memory={memory} disabled={false} />
        <HomeInputControls
          account={account}
          sessionFence="owner:1"
          memory={memory}
          value="Typed"
          onChange={vi.fn()}
          language="en-US"
          voiceAdapter={silentVoice}
          policy={policy}
          availability={{ status: "available" }}
          disabled={false}
        />
      </>,
    ),
  );
  expect(host.querySelector(".home-attachment-chips")).toBeNull();
  expect(picker(host).disabled).toBe(false);
  expect(picker(host).accept).toBe("text/plain,image/png");
  const open = vi.spyOn(picker(host), "click").mockImplementation(() => undefined);
  await act(async () => attach(host).click());
  expect(open).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="status"]')).toBeNull();

  await choose(host, [textFile("notes.txt"), textFile("more.txt", "second")]);
  const chips = () => [...host.querySelectorAll(".home-attachment-chips > li")];
  expect(host.querySelector(".home-attachment-chips")?.getAttribute("aria-label")).toBe("Attached files");
  expect(chips().map((chip) => chip.querySelector(".home-attachment-name")?.textContent)).toEqual([
    "notes.txt",
    "more.txt",
  ]);
  expect(memory.get(account)?.files).toHaveLength(2);

  await act(async () => chips()[0]!.querySelector<HTMLButtonElement>('button[aria-label="Remove notes.txt"]')!.click());
  expect(chips().map((chip) => chip.querySelector(".home-attachment-name")?.textContent)).toEqual(["more.txt"]);
  expect(memory.get(account)?.files.map((file) => file.file.name)).toEqual(["more.txt"]);
});

it("a file that is not allowed is refused with a plain reason and the others are kept", async () => {
  const host = mount(),
    memory = createHomeInputSession();
  memory.bind(account);
  await act(async () =>
    root!.render(
      <>
        <HomeAttachmentChips account={account} memory={memory} disabled={false} />
        <HomeInputControls
          account={account}
          sessionFence="owner:1"
          memory={memory}
          value=""
          onChange={vi.fn()}
          language="en-US"
          voiceAdapter={silentVoice}
          policy={policy}
          availability={{ status: "available" }}
          disabled={false}
        />
      </>,
    ),
  );
  await choose(host, [
    textFile("notes.txt"),
    new NodeFile(["%PDF"], "deck.pdf", { type: "application/pdf" }) as unknown as File,
  ]);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "deck.pdf: this kind of file isn’t supported (use plain text, PNG).",
  );
  expect(memory.get(account)?.files.map((file) => file.file.name)).toEqual(["notes.txt"]);
});

it("a held prompt disables adding and removing files", async () => {
  const host = mount(),
    memory = createHomeInputSession();
  memory.bind(account);
  const render = (disabled: boolean) =>
    act(async () =>
      root!.render(
        <>
          <HomeAttachmentChips account={account} memory={memory} disabled={disabled} />
          <HomeInputControls
            account={account}
            sessionFence="owner:1"
            memory={memory}
            value=""
            onChange={vi.fn()}
            language="en-US"
            voiceAdapter={silentVoice}
            policy={policy}
            availability={{ status: "available" }}
            disabled={disabled}
          />
        </>,
      ),
    );
  await render(false);
  await choose(host, [textFile("notes.txt")]);
  await render(true);
  expect(attach(host).disabled).toBe(true);
  expect(picker(host).disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>(".home-attachment-remove")!.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>("button.home-voice-button")!.disabled).toBe(true);
});
