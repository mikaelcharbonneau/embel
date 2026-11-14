"use client";

import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import styles from "./floating-composer.module.css";
import { Icon } from "@/components/ui/icon";

type Props = {
  children: ReactNode;
  label?: string;
  /** Earlier messages that open above the message box, as on the Name page. */
  history?: ReactNode;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?(expanded: boolean): void;
  expandLabel?: string;
  collapseLabel?: string;
};

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, max));
// Content fades out over this distance above the message box.
const FADE = 32;

/** The message box at the bottom of a conversation, like Home's. Content
 * scrolling underneath fades out behind it, and the conversation reserves its
 * height so the last message can scroll fully above it. */
export function FloatingComposer({
  children,
  label = "Message composer",
  history,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  expandLabel = "Expand conversation",
  collapseLabel = "Collapse conversation",
}: Props) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const hasHistory = history !== undefined && history !== null && history !== false;
  const open = hasHistory && (expanded ?? internalExpanded);
  const expansionLabel = open ? collapseLabel : expandLabel;
  const compactHeight = useRef(0);
  const host = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLElement>(null),
    body = useRef<HTMLDivElement>(null);
  const historyControl = useRef<HTMLButtonElement>(null),
    historyRegion = useRef<HTMLDivElement>(null);
  const id = useId(),
    historyId = id + "-history",
    bodyId = id + "-body";

  const place = useCallback(() => {
    const h = host.current,
      p = panel.current;
    if (!h || !p) return;
    const rect = h.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const view = window.visualViewport;
    const vx = view?.offsetLeft ?? 0,
      vy = view?.offsetTop ?? 0;
    const pad = getComputedStyle(h);
    const left = Math.max(0, vx - rect.left) + parseFloat(pad.paddingLeft);
    const top = Math.max(0, vy - rect.top) + parseFloat(pad.paddingTop);
    const right =
      Math.min(rect.width, vx + (view?.width ?? window.innerWidth) - rect.left) - parseFloat(pad.paddingRight);
    const bottom =
      Math.min(rect.height, vy + (view?.height ?? window.innerHeight) - rect.top) - parseFloat(pad.paddingBottom);
    const width = Math.max(0, right - left),
      height = Math.max(0, bottom - top);
    h.style.setProperty("--fc-width", width + "px");
    h.style.setProperty("--fc-height", height + "px");
    p.style.visibility = width > 0 && height > 0 ? "" : "hidden";
    const size = p.getBoundingClientRect();
    // Anchored by its bottom centre: opening history grows upward and typing
    // does not displace the send control.
    p.style.setProperty("--fc-x", clamp(left + width / 2 - size.width / 2, left, right - size.width) + "px");
    p.style.setProperty("--fc-y", clamp(bottom - size.height, top, bottom - size.height) + "px");
    p.dataset.placed = "true";
    if (p.dataset.expanded !== "true") compactHeight.current = size.height;
    // Opening history should not introduce a tall blank footer under the last message.
    const clearance = Math.ceil(Math.min(height, compactHeight.current || 58) + parseFloat(pad.paddingBottom));
    h.style.setProperty("--fc-backing-height", clearance + FADE + "px");
    const workspace = h.offsetParent;
    if (workspace instanceof HTMLElement)
      workspace.style.setProperty("--floating-composer-clearance", clearance + "px");
  }, []);

  useLayoutEffect(() => {
    const h = host.current,
      p = panel.current;
    if (!h || !p) return;
    const workspace = h.offsetParent;
    const before =
      workspace instanceof HTMLElement ? workspace.style.getPropertyValue("--floating-composer-clearance") : "";
    let frame = 0;
    function schedule() {
      if (!frame)
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          place();
        });
    }
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    for (const node of [h, p, body.current]) if (node) observer?.observe(node);
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
    if (!open && historyRegion.current?.contains(document.activeElement))
      historyControl.current?.focus({ preventScroll: true });
  }, [open, place]);

  function toggleHistory() {
    if (expanded === undefined) setInternalExpanded(!open);
    onExpandedChange?.(!open);
  }
  return (
    <div ref={host} className={styles.host} data-floating-composer-host="">
      <section ref={panel} className={styles.panel} aria-label={label} data-floating-composer="" data-expanded={open}>
        {hasHistory && (
          <div className={styles.toolbar}>
            <button
              type="button"
              ref={historyControl}
              className={styles.tool}
              aria-label={expansionLabel}
              title={expansionLabel}
              aria-controls={historyId}
              aria-expanded={open}
              onClick={toggleHistory}
            >
              <Icon name={open ? "chevron-down" : "chevron-up"} size="sm" />
            </button>
          </div>
        )}
        {hasHistory && (
          <div ref={historyRegion} id={historyId} className={styles.history} hidden={!open}>
            {history}
          </div>
        )}
        <div ref={body} id={bodyId} className={styles.body}>
          {children}
        </div>
      </section>
    </div>
  );
}
