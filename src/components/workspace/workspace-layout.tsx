"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Button, IconButton } from "@/components/ui/button";

/** The chat's width range at every window width (design system, Workspace). */
export const CHAT_WIDTH = { min: 320, max: 560, initial: 400, step: 16 } as const;
const STORAGE_KEY = "embel.workspace.chat";
const WIDE_QUERY = "(min-width: 1024px)";

const clampWidth = (value: number) => Math.round(Math.min(CHAT_WIDTH.max, Math.max(CHAT_WIDTH.min, value)));

type ChatPreferences = { width: number; hidden: boolean };
const defaults: ChatPreferences = { width: CHAT_WIDTH.initial, hidden: false };

/** The chat's width and hidden state, remembered per browser. Storage may be unavailable (private windows,
 * blocked site data); the layout then works with the defaults. */
function readPreferences(): ChatPreferences {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return defaults;
    const { width, hidden } = parsed as Partial<ChatPreferences>;
    return {
      width: typeof width === "number" && Number.isFinite(width) ? clampWidth(width) : defaults.width,
      hidden: hidden === true,
    };
  } catch {
    return defaults;
  }
}
function writePreferences(value: ChatPreferences) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Not remembered in this browser; the layout keeps working.
  }
}

// One copy per tab, so every Workspace (and a remount) agrees with what is stored.
let stored: ChatPreferences | null = null;
const preferenceListeners = new Set<() => void>();
function currentPreferences() {
  stored ??= readPreferences();
  return stored;
}
function subscribePreferences(listener: () => void) {
  preferenceListeners.add(listener);
  return () => {
    preferenceListeners.delete(listener);
  };
}
function updatePreferences(next: (previous: ChatPreferences) => ChatPreferences) {
  const value = next(currentPreferences());
  if (value.width === stored?.width && value.hidden === stored.hidden) return;
  stored = value;
  writePreferences(value);
  for (const listener of [...preferenceListeners]) listener();
}

/** Forgets the copy read from storage (tests start each case from what storage holds). */
export function forgetChatPreferences() {
  stored = null;
}

function subscribeWide(onChange: () => void) {
  const query = typeof window.matchMedia === "function" ? window.matchMedia(WIDE_QUERY) : null;
  if (typeof query?.addEventListener !== "function") return () => undefined;
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
/** True at 1024 px and up, where the conversation is a side chat beside the work. */
export function useWideWorkspace() {
  return useSyncExternalStore(
    subscribeWide,
    () => Boolean(window.matchMedia?.(WIDE_QUERY).matches),
    () => false,
  );
}

export type WorkspaceState = {
  /** The side-chat layout is in use (1024 px and up). Below it the conversation is one column. */
  wide: boolean;
  chatWidth: number;
  chatHidden: boolean;
  /** The work area's measured content width in CSS px, or null before it is measured. The work area is also a
   * CSS size container named `work`, so result grids can use `@container work (...)`. */
  workWidth: number | null;
};
const WorkspaceContext = createContext<WorkspaceState | null>(null);
/** The Workspace around this component, or null outside one. */
export function useWorkspace() {
  return useContext(WorkspaceContext);
}

/** Lets the project shell hand its notices (conflicts, reviews) to the Workspace, which shows them at the top of the
 * work area. The shell shows them in place while no Workspace is mounted. */
export const WorkspaceNoticeContext = createContext<{ notices: ReactNode; host: (hosted: boolean) => void } | null>(
  null,
);

/**
 * The project conversation at wide width: the chat in a floating panel on the left, the step's work on the right.
 * The chat can be resized (320 to 560 px, by pointer or arrow keys) and hidden; both are remembered per browser.
 * Below 1024 px it is one column: the conversation, then the work, then the reply box docked at the bottom.
 */
export function Workspace({
  log,
  reply,
  work,
  workLabel = "Work",
  rows,
  logKey,
  overlayHost,
  label = "Brand conversation",
}: {
  /** The conversation's messages, oldest first. */
  log: ReactNode;
  /** The reply box. */
  reply: ReactNode;
  /** What the person judges or chooses for the step on screen. */
  work: ReactNode;
  workLabel?: string;
  /** Steps whose results must all be in view: one row (direction boards) or two (logo concepts). */
  rows?: 1 | 2;
  /** Changes when a message arrives; while the chat is hidden, Show chat then carries a counter. */
  logKey?: string;
  /** Receives the element that work-area dialogs (name details) render their `e-workspace__overlay` into. */
  overlayHost?: (element: HTMLDivElement | null) => void;
  label?: string;
}) {
  const wide = useWideWorkspace();
  // Stored preferences apply after hydration, so the server and the browser first render the same markup.
  const preferences = useSyncExternalStore(subscribePreferences, currentPreferences, () => defaults);
  const update = updatePreferences;
  const [dragging, setDragging] = useState(false);
  const [workWidth, setWorkWidth] = useState<number | null>(null);
  const chatId = useId();
  const main = useRef<HTMLDivElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const hideButton = useRef<HTMLButtonElement>(null);
  const focusAfterToggle = useRef<"show" | "hide" | null>(null);
  const notices = useContext(WorkspaceNoticeContext);
  const hostNotices = notices?.host;

  const hidden = wide && preferences.hidden;
  const width = preferences.width;
  // A message that arrives while the chat is hidden is marked on Show chat until the chat is shown again.
  const [seen, setSeen] = useState({ key: logKey, hidden });
  if (seen.hidden !== hidden || (!hidden && seen.key !== logKey)) setSeen({ key: logKey, hidden });
  const unread = hidden && seen.key !== logKey;
  // The project bar and the work-area overlay live outside this element; they read the chat's width and whether
  // it is shown from the document.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--workspace-chat-width", `${width}px`);
    root.dataset.workspace = hidden ? "hidden" : "chat";
    return () => {
      root.style.removeProperty("--workspace-chat-width");
      delete root.dataset.workspace;
    };
  }, [width, hidden]);
  useEffect(() => {
    hostNotices?.(true);
    return () => hostNotices?.(false);
  }, [hostNotices]);
  useEffect(() => {
    const node = main.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWorkWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (focusAfterToggle.current === "hide") showButton.current?.focus();
    if (focusAfterToggle.current === "show") hideButton.current?.focus();
    focusAfterToggle.current = null;
  }, [hidden]);

  function startResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    handle.focus({ preventScroll: true });
    setDragging(true);
    const chat = document.getElementById(chatId);
    const left = chat?.getBoundingClientRect().left ?? 0;
    const move = (moveEvent: globalThis.PointerEvent) =>
      update((previous) => ({ ...previous, width: clampWidth(moveEvent.clientX - left) }));
    const stop = () => {
      setDragging(false);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }
  function resizeByKey(event: KeyboardEvent<HTMLDivElement>) {
    const change: Record<string, (value: number) => number> = {
      ArrowLeft: (value) => value - CHAT_WIDTH.step,
      ArrowRight: (value) => value + CHAT_WIDTH.step,
      ArrowDown: (value) => value - CHAT_WIDTH.step,
      ArrowUp: (value) => value + CHAT_WIDTH.step,
      PageDown: (value) => value - CHAT_WIDTH.step * 4,
      PageUp: (value) => value + CHAT_WIDTH.step * 4,
      Home: () => CHAT_WIDTH.min,
      End: () => CHAT_WIDTH.max,
    };
    const next = change[event.key];
    if (!next) return;
    event.preventDefault();
    update((previous) => ({ ...previous, width: clampWidth(next(previous.width)) }));
  }
  const setHidden = (value: boolean) => {
    focusAfterToggle.current = value ? "hide" : "show";
    update((previous) => ({ ...previous, hidden: value }));
  };

  const state: WorkspaceState = { wide, chatWidth: width, chatHidden: hidden, workWidth };
  const rowsClass = rows ? ` e-workspace__main--rows-${rows}` : "";
  return (
    <WorkspaceContext.Provider value={state}>
      <div
        className={`e-workspace conversation-workspace${hidden ? " e-workspace--chat-hidden" : ""}`}
        style={{ "--workspace-chat-width": `${width}px` } as CSSProperties}
        aria-label={label}
        role="region"
      >
        <section id={chatId} className="e-workspace__chat" aria-label="Chat" hidden={hidden}>
          <div className="e-workspace__head">
            <h2 className="e-workspace__title">Chat</h2>
            <IconButton
              ref={hideButton}
              icon="panel-left-close"
              label="Hide chat"
              size="sm"
              aria-controls={chatId}
              aria-expanded
              onClick={() => setHidden(true)}
            />
          </div>
          <div className="e-workspace__log" role="log" aria-label="Conversation" aria-live="polite" tabIndex={0}>
            <div className="e-workspace__thread">{log}</div>
          </div>
          <div className="e-workspace__reply">{reply}</div>
        </section>
        {!hidden && (
          <div
            className="e-workspace__resize"
            role="separator"
            aria-label="Resize chat"
            aria-orientation="vertical"
            aria-controls={chatId}
            aria-valuemin={CHAT_WIDTH.min}
            aria-valuemax={CHAT_WIDTH.max}
            aria-valuenow={width}
            aria-valuetext={`Chat ${width} pixels wide`}
            tabIndex={wide ? 0 : -1}
            data-state={dragging ? "dragging" : undefined}
            onPointerDown={startResize}
            onKeyDown={resizeByKey}
          />
        )}
        <div
          ref={main}
          className={`e-workspace__main conversation-work${rowsClass}`}
          aria-label={workLabel}
          role="region"
        >
          {notices?.notices}
          {work}
        </div>
        <div ref={overlayHost} className="conversation-overlay-host" />
        {hidden && (
          <div className="e-workspace__show">
            <Button
              ref={showButton}
              icon="panel-left-open"
              className="workspace-show-chat"
              aria-controls={chatId}
              aria-expanded={false}
              title="Show chat"
              onClick={() => setHidden(false)}
            >
              Show chat
              {unread && (
                <span className="e-counter" aria-label="New message">
                  1
                </span>
              )}
            </Button>
          </div>
        )}
      </div>
    </WorkspaceContext.Provider>
  );
}
