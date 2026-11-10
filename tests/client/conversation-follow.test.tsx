// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationFollow } from "@/components/workspace/use-conversation-follow";

type Response = { id: string; top: number };
let root: Root, host: HTMLDivElement;
let height = 1000,
  viewport = 400,
  reducedMotion = false;
const scrollTo = vi.fn(function (this: HTMLDivElement, options: ScrollToOptions) {
  this.scrollTop = Math.max(0, Math.min(options.top ?? 0, height - viewport));
});

function Conversation({
  responses = [],
  contentKey = "initial",
  conversationKey = "account:project",
}: {
  responses?: Response[];
  contentKey?: string;
  conversationKey?: string;
}) {
  const { transcript, onScroll, hasNewResponse, revealNewResponse } = useConversationFollow({
    conversationKey,
    contentKey,
    responseIds: responses.map((response) => response.id),
  });
  return (
    <>
      <div ref={transcript} id="transcript" onScroll={onScroll} tabIndex={0}>
        <button id="earlier-control">Earlier answer</button>
        {responses.map((response) => (
          <article key={response.id} id={response.id} data-top={response.top} tabIndex={-1}>
            {response.id}
          </article>
        ))}
      </div>
      {hasNewResponse && (
        <button id="new-response" onClick={revealNewResponse}>
          View new response
        </button>
      )}
      <textarea aria-label="Message" />
    </>
  );
}

async function render(props: Parameters<typeof Conversation>[0] = {}) {
  await act(async () => root.render(createElement(Conversation, props)));
}
function area() {
  return host.querySelector<HTMLDivElement>("#transcript")!;
}
function unread() {
  return host.querySelector<HTMLButtonElement>("#new-response");
}
async function scroll(top: number) {
  await act(async () => {
    area().scrollTop = top;
    area().dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  height = 1000;
  viewport = 400;
  reducedMotion = false;
  scrollTo.mockClear();
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return this.id === "transcript" ? height : 0;
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this.id === "transcript" ? viewport : 0;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const top = this.id === "transcript" ? 0 : Number((this as HTMLElement).dataset.top ?? 0) - area().scrollTop;
    return { top, bottom: top, left: 0, right: 0, x: 0, y: top, width: 0, height: 0, toJSON: () => ({}) };
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: reducedMotion })),
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, writable: true, value: scrollTo });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("conversation follow intent", () => {
  it("follows near the bottom without stealing the composer's focus", async () => {
    await render();
    expect(area().scrollTop).toBe(600);
    const composer = host.querySelector("textarea")!;
    composer.focus();
    await scroll(530);
    scrollTo.mockClear();
    height = 1400;
    await render({ responses: [{ id: "answer-1", top: 1000 }], contentKey: "reply" });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 976, behavior: "auto" });
    expect(document.activeElement).toBe(composer);
    expect(unread()).toBeNull();
  });

  it("keeps older content and keyboard focus in place when a reply arrives", async () => {
    await render();
    await scroll(180);
    const earlier = host.querySelector<HTMLButtonElement>("#earlier-control")!;
    earlier.focus();
    scrollTo.mockClear();
    height = 1600;
    await render({ responses: [{ id: "answer-1", top: 1000 }], contentKey: "reply" });
    expect(area().scrollTop).toBe(180);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(earlier);
    expect(unread()?.textContent).toBe("View new response");
  });

  it("explicitly reveals the first unread reply and transfers focus before removing the button", async () => {
    await render();
    await scroll(100);
    height = 1800;
    await render({ responses: [{ id: "answer-1", top: 900 }], contentKey: "first-reply" });
    await render({
      responses: [
        { id: "answer-1", top: 900 },
        { id: "answer-2", top: 1300 },
      ],
      contentKey: "second-reply",
    });
    scrollTo.mockClear();
    await act(async () => {
      unread()!.focus();
      unread()!.click();
    });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 876, behavior: "smooth" });
    expect(document.activeElement?.id).toBe("answer-1");
    expect(unread()).toBeNull();
  });

  it("honors reduced motion at the time the reader requests a jump", async () => {
    await render();
    await scroll(100);
    height = 1500;
    await render({ responses: [{ id: "answer-1", top: 1000 }], contentKey: "reply" });
    reducedMotion = true;
    scrollTo.mockClear();
    await act(async () => unread()!.click());
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 976, behavior: "auto" });
  });

  it("clears the affordance when the reader returns near the bottom and follows later content", async () => {
    await render();
    await scroll(100);
    height = 1500;
    await render({ responses: [{ id: "answer-1", top: 1000 }], contentKey: "reply" });
    expect(unread()).not.toBeNull();
    await scroll(1070);
    expect(unread()).toBeNull();
    scrollTo.mockClear();
    height = 1600;
    await render({ responses: [{ id: "answer-1", top: 1000 }], contentKey: "thinking" });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1600, behavior: "auto" });
  });

  it("does not jump on repeated reads or ordinary status changes while reading older content", async () => {
    await render();
    await scroll(100);
    scrollTo.mockClear();
    await render();
    await render({ contentKey: "thinking" });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(unread()).toBeNull();
  });

  it("reveals a long answer from its beginning and does not skip the reader ahead to the next answer", async () => {
    await render({ responses: [{ id: "long-answer", top: 200 }] });
    expect(area().scrollTop).toBe(176);
    scrollTo.mockClear();
    height = 1800;
    await render({
      responses: [
        { id: "long-answer", top: 200 },
        { id: "next-answer", top: 1200 },
      ],
      contentKey: "next-reply",
    });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(unread()).not.toBeNull();
  });

  it("uses current viewport dimensions when the reader resumes following after a resize", async () => {
    await render();
    await scroll(100);
    viewport = 800;
    await scroll(150);
    scrollTo.mockClear();
    height = 1400;
    await render({ responses: [{ id: "answer-1", top: 1000 }], contentKey: "reply" });
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(unread()).toBeNull();
  });

  it("resets unread state and scroll intent for a different account, generation or project", async () => {
    await render();
    await scroll(100);
    height = 1400;
    await render({ responses: [{ id: "answer-1", top: 1000 }], contentKey: "reply" });
    expect(unread()).not.toBeNull();
    scrollTo.mockClear();
    await render({ conversationKey: "other-account:project" });
    expect(unread()).toBeNull();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1400, behavior: "auto" });
  });
});
