// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "@/components/ui/button";
import { ArtworkChoice, ChoiceCard } from "@/components/ui/choice";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { MediaFrame } from "@/components/ui/media-frame";
import { Menu } from "@/components/ui/menu";
import { InlineMessage } from "@/components/ui/message";
import { ToastProvider, useToast } from "@/components/ui/toast";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.show = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});
const render = (node: React.ReactNode) => act(async () => root.render(node));
const press = (element: Element | null) => act(async () => (element as HTMLElement).click());
const key = (element: Element | null, name: string) =>
  act(async () => {
    element!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });

describe("Button", () => {
  it("keeps its label and focus while busy, and ignores presses", async () => {
    const onClick = vi.fn();
    await render(
      <Button variant="primary" loading onClick={onClick}>
        Save changes
      </Button>,
    );
    const button = host.querySelector("button")!;
    expect(button.textContent).toBe("Save changes");
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.querySelector(".e-spinner")).not.toBeNull();
    await press(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(button.className).toBe("e-button e-button--primary");
  });

  it("names an icon button and shows the same words as its tooltip", async () => {
    await render(<IconButton icon="heart" label="Like Kestrel" pressed={false} />);
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Like Kestrel");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector(".e-tooltip")?.textContent).toBe("Like Kestrel");
  });
});

describe("Icon", () => {
  it("draws the Lucide mask, maps older names and rounds pixel sizes to the three allowed sizes", async () => {
    await render(
      <>
        <Icon name="close" size={14} />
        <Icon name="search" />
        <Icon name="folder" size={28} />
      </>,
    );
    const icons = [...host.querySelectorAll(".e-icon")];
    expect(icons.map((icon) => icon.getAttribute("data-icon"))).toEqual(["x", "search", "folder"]);
    expect(icons.map((icon) => icon.className)).toEqual(["e-icon e-icon--sm", "e-icon", "e-icon e-icon--lg"]);
    expect(icons.every((icon) => icon.getAttribute("aria-hidden") === "true")).toBe(true);
  });
});

describe("TextField", () => {
  it("links the hint and the error to the input and marks it invalid", async () => {
    await render(<TextField label="Email" type="email" hint="We send a link here." error="Enter an email address." />);
    const input = host.querySelector("input")!;
    const described = input.getAttribute("aria-describedby")!.split(" ");
    expect(described.map((id) => document.getElementById(id)?.textContent)).toEqual([
      "We send a link here.",
      "Enter an email address.",
    ]);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector("label")?.getAttribute("for")).toBe(input.id);
  });

  it("toggles a password between hidden and shown", async () => {
    await render(<TextField label="Password" type="password" />);
    const toggle = host.querySelector('button[aria-label="Show password"]');
    await press(toggle);
    expect(host.querySelector("input")!.type).toBe("text");
    expect(host.querySelector("button")!.getAttribute("aria-label")).toBe("Hide password");
  });
});

describe("InlineMessage", () => {
  it("is an alert for danger and a polite status for positive, always with an icon", async () => {
    await render(
      <>
        <InlineMessage tone="danger">Your changes weren&apos;t saved.</InlineMessage>
        <InlineMessage tone="positive">Payment confirmed.</InlineMessage>
      </>,
    );
    const [danger, positive] = [...host.querySelectorAll(".e-message")];
    expect(danger!.getAttribute("role")).toBe("alert");
    expect(danger!.querySelector(".e-icon")?.getAttribute("data-icon")).toBe("circle-alert");
    expect(positive!.getAttribute("role")).toBe("status");
  });
});

describe("Dialog", () => {
  function Harness({ busy = false }: { busy?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Delete project
        </button>
        {open ? (
          <Dialog title="Delete this project?" size="sm" busy={busy} onClose={() => setOpen(false)}>
            <p>It moves to Deleted.</p>
          </Dialog>
        ) : null}
      </>
    );
  }

  it("opens as a modal, is named by its title and returns focus to the opener on Escape", async () => {
    await render(<Harness />);
    const opener = host.querySelector("button")!;
    opener.focus();
    await press(opener);
    const dialog = host.querySelector("dialog")!;
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Delete this project?");
    await act(async () => {
      dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(host.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("stays open while its action runs", async () => {
    await render(<Harness busy />);
    await press(host.querySelector("button"));
    await press(host.querySelector('dialog button[aria-label="Close"]'));
    expect(host.querySelector("dialog")).not.toBeNull();
  });

  it("keeps a badge beside the title out of its name and puts header actions before Close", async () => {
    const favorite = vi.fn();
    await render(
      <Dialog
        title="Kestrel Analytics"
        size="xl"
        aside={<span className="e-badge">Your name</span>}
        actions={<IconButton icon="heart" label="Favorite Kestrel Analytics" tooltip={false} onClick={favorite} />}
        onClose={() => {}}
      />,
    );
    const dialog = host.querySelector("dialog")!;
    expect(dialog.className).toContain("e-dialog--xl");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Kestrel Analytics");
    expect(dialog.querySelector("header")!.textContent).toContain("Your name");
    const headerButtons = [...dialog.querySelectorAll("header button")].map((b) => b.getAttribute("aria-label"));
    expect(headerButtons).toEqual(["Favorite Kestrel Analytics", "Close"]);
    await press(dialog.querySelector('button[aria-label="Favorite Kestrel Analytics"]'));
    expect(favorite).toHaveBeenCalledOnce();
  });
});

describe("Menu", () => {
  it("moves with the arrow keys, runs the chosen row and returns focus to the trigger", async () => {
    const rename = vi.fn();
    const remove = vi.fn();
    await render(
      <Menu
        trigger={(props) => (
          <button type="button" {...props}>
            Options
          </button>
        )}
        items={[
          { kind: "action", label: "Rename", icon: "pencil", onSelect: rename },
          { kind: "separator" },
          { kind: "action", label: "Delete project", icon: "trash-2", danger: true, onSelect: remove },
        ]}
      />,
    );
    const trigger = host.querySelector("button")!;
    await press(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const rows = [...host.querySelectorAll('[role="menuitem"]')];
    expect(document.activeElement).toBe(rows[0]);
    await key(rows[0]!, "ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
    expect(rows[1]!.className).toContain("e-menu__item--danger");
    await key(rows[1]!, "Escape");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    await press(trigger);
    await press(host.querySelector('[role="menuitem"]'));
    expect(rename).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("Menu dismissal", () => {
  it("closes on a press outside and keeps that press, click included, from reaching what is underneath", async () => {
    const underneath = vi.fn();
    await render(
      <>
        <Menu
          trigger={(props) => (
            <button type="button" {...props}>
              Options
            </button>
          )}
          items={[{ kind: "action", label: "Rename", onSelect: () => {} }]}
        />
        <button type="button" onClick={underneath}>
          Underneath
        </button>
      </>,
    );
    const [trigger, outside] = [...host.querySelectorAll("button")];
    await press(trigger!);
    expect(trigger!.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      outside!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      outside!.click();
    });
    expect(trigger!.getAttribute("aria-expanded")).toBe("false");
    expect(underneath).not.toHaveBeenCalled();
    await press(outside!);
    expect(underneath).toHaveBeenCalledOnce();
  });
});

describe("Toast", () => {
  function Copy() {
    const toast = useToast();
    return (
      <button type="button" onClick={() => toast("Colours copied")}>
        Copy colours
      </button>
    );
  }

  it("shows one polite confirmation and leaves after five seconds", async () => {
    vi.useFakeTimers();
    await render(
      <ToastProvider>
        <Copy />
      </ToastProvider>,
    );
    await press(host.querySelector("button"));
    const region = host.querySelector(".e-toast-region")!;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent).toContain("Colours copied");
    await act(async () => vi.advanceTimersByTime(4999));
    expect(region.textContent).toContain("Colours copied");
    await act(async () => vi.advanceTimersByTime(1));
    expect(region.textContent).toBe("");
  });
});

describe("Choice cards", () => {
  it("marks the chosen text option with the ring only, through a real radio", async () => {
    await render(
      <ChoiceCard name="audience" value="parents" title="Parents of anxious children" checked onChange={() => {}} />,
    );
    const input = host.querySelector("input")!;
    expect(input.type).toBe("radio");
    expect(input.checked).toBe(true);
    expect(host.querySelector(".e-choice__mark")?.textContent).toBe("");
  });

  it("makes the whole logo concept a toggle named after it, and offers no choice while it is drawn", async () => {
    const choose = vi.fn();
    await render(<ArtworkChoice label="Concept 2" src="/logo.png" selected onChoose={choose} onEnlarge={() => {}} />);
    const hit = host.querySelector(".e-choice__hit")!;
    expect(hit.getAttribute("aria-label")).toBe("Concept 2");
    expect(hit.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".e-choice")?.hasAttribute("data-selected")).toBe(true);
    await press(hit);
    expect(choose).toHaveBeenCalledOnce();

    await render(<ArtworkChoice label="Concept 3" state="drawing" selected={false} onChoose={choose} />);
    expect(host.querySelector(".e-choice__hit")).toBeNull();
    expect(host.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Concept 3 is being drawn");
  });
});

describe("Media frame and empty state", () => {
  it("says a private preview is private and gives a failed image one sentence", async () => {
    await render(
      <>
        <MediaFrame state="private" />
        <MediaFrame state="failed" failedText="This concept couldn't be drawn." />
      </>,
    );
    const frames = [...host.querySelectorAll(".e-media")];
    expect(frames.map((frame) => frame.textContent)).toEqual([
      "This preview is private.",
      "This concept couldn't be drawn.",
    ]);
  });

  it("gives an empty page one icon, a title, a sentence and one action", async () => {
    await render(
      <EmptyState icon="folder" title="No projects yet" text="Start with an idea." action={<Button>Start</Button>} />,
    );
    expect(host.querySelector(".e-empty__visual .e-icon")?.getAttribute("data-icon")).toBe("folder");
    expect(host.querySelector("h2")?.textContent).toBe("No projects yet");
    expect(host.querySelectorAll(".e-empty button")).toHaveLength(1);
  });
});
