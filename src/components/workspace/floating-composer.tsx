"use client";

import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import styles from "./floating-composer.module.css";

type Props = {
  children: ReactNode;
  label?: string;
  history?: ReactNode;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?(expanded: boolean): void;
  expandLabel?: string;
  collapseLabel?: string;
  minimized?: boolean;
  onMinimizedChange?(minimized: boolean): void;
  /** Bottom center of the panel as fractions of the available workspace. */
  defaultPosition?: Point | null;
  onPositionChange?(position: Point | null): void;
};

type Point = { x: number; y: number };
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, max));
const offsets: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
};

function Symbol({ name }: { name: "minimize" | "restore" | "open" | "close" | "reset" }) {
  const paths = {
    minimize: "M4 8h8",
    restore: "M3 3.5h10v7H7l-3.5 2v-2H3z",
    open: "m4 10 4-4 4 4",
    close: "m4 6 4 4 4-4",
    reset: "M6 3 3 6l3 3M3.5 6h6a3.5 3.5 0 1 1 0 7H7",
  };
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}

export function FloatingComposer({ children, label = "Message composer", history, expanded, defaultExpanded = false,
  onExpandedChange, expandLabel, collapseLabel, minimized, onMinimizedChange, defaultPosition, onPositionChange }: Props) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const [internalMinimized, setInternalMinimized] = useState(false);
  const [moved, setMoved] = useState(Boolean(defaultPosition));
  const open = expanded ?? internalExpanded, mini = minimized ?? internalMinimized;
  const hasHistory = history !== undefined && history !== null && history !== false;
  const expansionLabel = open ? collapseLabel ?? (hasHistory ? "Collapse conversation" : "Collapse composer") : expandLabel ?? (hasHistory ? "Expand conversation" : "Expand composer");
  const grip = useRef<HTMLButtonElement>(null), compactHeight = useRef(0);
  const host = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null), toolbar = useRef<HTMLDivElement>(null);
  const minimizeControl = useRef<HTMLButtonElement>(null), historyControl = useRef<HTMLButtonElement>(null);
  const historyRegion = useRef<HTMLDivElement>(null), lastField = useRef<HTMLElement | null>(null);
  const manual = useRef<Point | null>(defaultPosition ?? null), actual = useRef<Point>({ x: 0, y: 0 });
  const drag = useRef<{ pointer: number; start: Point; anchor: Point; moved: boolean } | null>(null);
  const previousMini = useRef(mini);
  const id = useId(), helpId = id + "-move", historyId = id + "-history", bodyId = id + "-body";

  const place = useCallback((requested?: Point) => {
    const h = host.current, p = panel.current, content = body.current, bar = toolbar.current;
    if (!h || !p || !content || !bar) return;
    const rect = h.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const view = window.visualViewport;
    const vx = view?.offsetLeft ?? 0, vy = view?.offsetTop ?? 0;
    const pad = getComputedStyle(h);
    const left = Math.max(0, vx - rect.left) + parseFloat(pad.paddingLeft);
    const top = Math.max(0, vy - rect.top) + parseFloat(pad.paddingTop);
    const right = Math.min(rect.width, vx + (view?.width ?? window.innerWidth) - rect.left) - parseFloat(pad.paddingRight);
    const bottom = Math.min(rect.height, vy + (view?.height ?? window.innerHeight) - rect.top) - parseFloat(pad.paddingBottom);
    const width = Math.max(0, right - left), height = Math.max(0, bottom - top);
    h.style.setProperty("--fc-width", width + "px");
    h.style.setProperty("--fc-height", height + "px");
    p.style.visibility = width > 0 && height > 0 ? "" : "hidden";
    const size = p.getBoundingClientRect();
    // Anchor the panel by its bottom centre so opening history grows upward
    // and typing/reflowing the message does not displace the send control.
    const anchor = requested ?? { x: left + width * (manual.current?.x ?? 0.5), y: top + height * (manual.current?.y ?? 1) };
    const x = clamp(anchor.x - size.width / 2, left, right - size.width);
    const y = clamp(anchor.y - size.height, top, bottom - size.height);
    actual.current = { x: x + size.width / 2, y: y + size.height };
    if (requested && width > 0 && height > 0) {
      manual.current = {
        x: clamp((actual.current.x - left) / width, 0, 1),
        y: clamp((actual.current.y - top) / height, 0, 1),
      };
    }
    p.style.setProperty("--fc-x", x + "px");
    p.style.setProperty("--fc-y", y + "px");
    p.dataset.placed = "true";
    const isMinimized = p.dataset.minimized === "true";
    if (!isMinimized && p.dataset.expanded !== "true") compactHeight.current = size.height;
    // Expanding should not introduce a tall blank footer under the last message.
    const clearance = isMinimized ? size.height : Math.min(height, compactHeight.current || 58);
    const workspace = h.offsetParent;
    if (workspace instanceof HTMLElement) workspace.style.setProperty("--floating-composer-clearance", Math.ceil(clearance + parseFloat(pad.paddingBottom)) + "px");
  }, []);

  useLayoutEffect(() => {
    const h = host.current, p = panel.current;
    if (!h || !p) return;
    const workspace = h.offsetParent;
    const before = workspace instanceof HTMLElement ? workspace.style.getPropertyValue("--floating-composer-clearance") : "";
    let frame = 0;
    function schedule() {
      if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; place(); });
    }
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    for (const node of [h, p, body.current, toolbar.current]) if (node) observer?.observe(node);
    const view = window.visualViewport;
    window.addEventListener("resize", schedule);
    // Scrolls inside results/history do not move the host. Only ancestor
    // scrolling can change its intersection with the visual viewport.
    function scroll(event: Event) {
      const target = event.target;
      if (target === document || (target instanceof Element && target.contains(h))) schedule();
    }
    window.addEventListener("scroll", scroll, true);
    view?.addEventListener("resize", schedule);
    view?.addEventListener("scroll", schedule);
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", scroll, true);
      view?.removeEventListener("resize", schedule);
      view?.removeEventListener("scroll", schedule);
      if (workspace instanceof HTMLElement) {
        if (before) workspace.style.setProperty("--floating-composer-clearance", before);
        else workspace.style.removeProperty("--floating-composer-clearance");
      }
    };
  }, [place]);

  useLayoutEffect(() => {
    place();
    if (mini && body.current?.contains(document.activeElement)) minimizeControl.current?.focus({ preventScroll: true });
    if (!open && historyRegion.current?.contains(document.activeElement)) historyControl.current?.focus({ preventScroll: true });
    if (previousMini.current && !mini && document.activeElement === minimizeControl.current) {
      const field = lastField.current;
      if (field?.isConnected && field.getClientRects().length) field.focus({ preventScroll: true });
    }
    previousMini.current = mini;
  }, [mini, open, place]);

  function reset() {
    manual.current = null;
    setMoved(false);
    place();
    onPositionChange?.(null);
  }
  function move(point: Point) {
    setMoved(true);
    place(point);
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!event.isPrimary || event.button !== 0 || drag.current) return;
    event.preventDefault(); // Dragging should preserve a textarea's caret and keyboard.
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, anchor: { ...actual.current }, moved: false };
  }
  function dragTo(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    const dx = event.clientX - active.start.x, dy = event.clientY - active.start.y;
    if (dx || dy || active.moved) {
      active.moved = true;
      move({ x: active.anchor.x + dx, y: active.anchor.y + dy });
    }
  }
  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointer !== event.pointerId) return;
    if (drag.current.moved) onPositionChange?.(manual.current);
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function keyMove(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Home") { event.preventDefault(); reset(); return; }
    const direction = offsets[event.key];
    if (!direction) return;
    event.preventDefault();
    const distance = event.shiftKey ? 64 : 16;
    move({ x: actual.current.x + direction.x * distance, y: actual.current.y + direction.y * distance });
    onPositionChange?.(manual.current);
  }
  function toggleHistory() {
    if (expanded === undefined) setInternalExpanded(!open);
    onExpandedChange?.(!open);
  }
  function toggleMinimize() {
    if (minimized === undefined) setInternalMinimized(!mini);
    onMinimizedChange?.(!mini);
  }
  return <div ref={host} className={styles.host} data-floating-composer-host="">
    <section ref={panel} className={styles.panel} aria-label={label} data-floating-composer="" data-minimized={mini} data-expanded={open && !mini}>
      <div ref={toolbar} className={styles.toolbar}>
        <button ref={grip} className={styles.handle} type="button" aria-label="Move composer" aria-describedby={helpId} title="Move composer"
          onPointerDown={startDrag} onPointerMove={dragTo} onPointerUp={endDrag} onPointerCancel={endDrag}
          onLostPointerCapture={endDrag} onDoubleClick={reset} onKeyDown={keyMove}><span /></button>
        <span id={helpId} className="sr-only">Drag to move, or use arrow keys. Hold Shift for larger steps. Home resets the position.</span>
        {moved && <button type="button" className={styles.tool} aria-label="Reset composer position" title="Reset composer position" onClick={() => { grip.current?.focus({preventScroll:true}); reset(); }}><Symbol name="reset" /></button>}
        {!mini && <button type="button" ref={historyControl} className={styles.tool} aria-label={expansionLabel}
          title={expansionLabel} aria-controls={hasHistory ? historyId : bodyId} aria-expanded={open} onClick={toggleHistory}><Symbol name={open ? "close" : "open"} /></button>}
        <button type="button" ref={minimizeControl} className={styles.tool} aria-label={mini ? "Restore composer" : "Minimize composer"} title={mini ? "Restore composer" : "Minimize composer"}
          aria-controls={bodyId} aria-expanded={!mini} onClick={toggleMinimize}><Symbol name={mini ? "restore" : "minimize"} />{mini && <span>Message</span>}</button>
      </div>
      {hasHistory && <div ref={historyRegion} id={historyId} className={styles.history} hidden={mini || !open}>{history}</div>}
      <div ref={body} id={bodyId} className={styles.body} hidden={mini} onFocusCapture={event => {
        const target = event.target;
        if (target instanceof HTMLElement && target.matches("textarea, input, [contenteditable=true]")) lastField.current = target;
      }}>{children}</div>
    </section>
  </div>;
}
