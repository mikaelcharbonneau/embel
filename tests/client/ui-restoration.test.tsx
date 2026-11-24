// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ConversationComposer } from "@/components/workspace/conversation-composer";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => document.body.replaceChildren());
describe("original Embel composer presentation", () => {
  it("keeps the send action named and functional when its visual label is compact", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host),
      send = vi.fn();
    await act(async () =>
      root.render(
        createElement(ConversationComposer, {
          value: "A useful brief",
          onChange: vi.fn(),
          onSend: send,
          label: "Your prompt",
          placeholder: "Start here",
          initial: true,
          inputControls: createElement("button", { type: "button" }, "Files"),
        }),
      ),
    );
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.getAttribute("aria-label")).toBe("Send prompt");
    expect(host.querySelector(".conversation-composer-footer")?.textContent).toContain("Files");
    await act(async () => submit.click());
    expect(send).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });
  it("shows recovery action text instead of reducing it to an unexplained icon", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(ConversationComposer, {
          value: "Brief",
          onChange: vi.fn(),
          onSend: vi.fn(),
          label: "Your prompt",
          placeholder: "Start here",
          initial: true,
          sendLabel: "Check and retry attached brief",
        }),
      ),
    );
    expect(host.querySelector('button[type="submit"]')?.textContent).toBe("Check and retry attached brief");
    expect(host.querySelector('button[type="submit"] .sr-only')).toBeNull();
    await act(async () => root.unmount());
  });
  it("removes the rejected magenta composer edge", () => {
    const css = readFileSync("src/styles/conversation.css", "utf8");
    expect(css).not.toMatch(/\.conversation-composer\.is-initial\s*\{[^}]*border-top:\s*2px solid var\(--magenta\)/);
  });
});

describe("Home composer narrow-layout source contract (not rendered geometry)", () => {
  it("keeps notes and statuses in normal flow on their own row after the attach and dictate buttons", () => {
    const css = readFileSync("src/styles/globals.css", "utf8");
    const footer = css.match(/\.conversation-composer-footer:has\(\.home-input-controls\) \{([^}]+)\}/)?.[1];
    const controls = css.match(/\.home-input-controls \{([^}]+)\}/)?.[1];
    const notes = css.match(/\.home-input-controls > p,\s*\.home-input-controls > div \{([^}]+)\}/)?.[1];
    expect(footer).toContain("flex-wrap: wrap");
    // The buttons join the footer's own row, so Send stays beside them.
    expect(controls).toContain("display: contents");
    expect(notes).toContain("flex: 1 0 100%");
    expect(notes).toContain("order: 3");
    expect(notes).not.toContain("position: absolute");
  });
  it("reflows full recovery actions inside the narrow composer", () => {
    const css = readFileSync("src/styles/conversation.css", "utf8");
    const narrow = css.slice(css.indexOf("/* Home input recovery at narrow widths"));
    expect(narrow).toContain("@media (max-width: 760px)");
    expect(narrow).toMatch(/\.conversation-composer\.is-initial \.conversation-composer-footer \{[^}]*flex-wrap: wrap/);
    expect(narrow).toMatch(
      /\.conversation-composer\.is-initial \.conversation-composer-footer > \.button \{[^}]*max-width: 100%[^}]*white-space: normal/,
    );
  });
  it.each(["Send prompt", "Open saved brand", "Check and retry save"])(
    "preserves the %s action beside mounted controls",
    async (sendLabel) => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host),
        send = vi.fn();
      await act(async () =>
        root.render(
          createElement(ConversationComposer, {
            value: "Retained brief",
            onChange: vi.fn(),
            onSend: send,
            label: "Your prompt",
            placeholder: "Start here",
            initial: true,
            sendLabel,
            inputControls: createElement(
              "div",
              { className: "home-input-controls" },
              createElement("button", { type: "button" }, "Files"),
              createElement("button", { type: "button" }, "Voice"),
              createElement("p", { role: "status" }, "File selection was interrupted."),
            ),
          }),
        ),
      );
      const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      expect(submit.getAttribute("aria-label") ?? submit.textContent).toBe(sendLabel);
      expect(host.querySelector(".home-input-controls [role=status]")?.textContent).toBe(
        "File selection was interrupted.",
      );
      expect(host.querySelectorAll(".home-input-controls button")).toHaveLength(2);
      await act(async () => submit.click());
      expect(send).toHaveBeenCalledOnce();
      await act(async () => root.unmount());
    },
  );
});

describe("Home composer mobile-shell breakpoint coverage (source only)", () => {
  it.each([320, 375, 540, 541, 600, 670, 760])("includes the %i px viewport in the wrapping footer rules", (width) => {
    const css = readFileSync("src/styles/conversation.css", "utf8");
    const narrow = css.slice(css.indexOf("/* Home input recovery at narrow widths"));
    const maximumWidth = Number(narrow.match(/@media \(max-width: (\d+)px\)/)?.[1]);
    expect(maximumWidth).toBe(760);
    expect(width).toBeLessThanOrEqual(maximumWidth);
    expect(narrow).toMatch(/\.conversation-composer\.is-initial \.conversation-composer-footer \{[^}]*flex-wrap: wrap/);
  });
});
