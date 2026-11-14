"use client";

import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Icon, type IconName } from "./icon";

export type MenuItem =
  | { kind: "action"; label: string; icon?: IconName; onSelect: () => void; danger?: boolean; disabled?: boolean }
  | {
      kind: "link";
      label: string;
      icon?: IconName;
      href: string;
      onClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
    }
  | { kind: "choice"; label: string; checked: boolean; onSelect: () => void }
  | { kind: "separator" }
  | { kind: "label"; label: string };

/**
 * A floating list of actions or choices under its trigger. Opens on press, moves with the arrow keys, Home and End;
 * closes on Escape (focus returns to the trigger), on a press outside and when focus leaves. The press that closes
 * it is not passed to what is underneath. The destructive row goes last, after a separator.
 */
export function Menu({
  trigger,
  items,
  summary,
  label,
  align = "end",
  className,
  closeOn,
}: {
  /** Renders the trigger; spread the props onto a button. */
  trigger: (props: {
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    "aria-controls": string;
    onClick: () => void;
    ref: RefObject<HTMLButtonElement | null>;
  }) => ReactNode;
  items: MenuItem[];
  /** A block at the top that is not a row, such as the plan and balance in the account menu. */
  summary?: ReactNode;
  /** The menu's accessible name when the trigger's own name is not enough ("Actions for Kestrel Analytics"). */
  label?: string;
  align?: "start" | "end";
  className?: string;
  /** The menu closes whenever this value changes (pass the current page, so moving pages closes it). */
  closeOn?: unknown;
}) {
  const [open, setOpen] = useState(false);
  const [closedFor, setClosedFor] = useState(closeOn);
  if (closedFor !== closeOn) {
    setClosedFor(closeOn);
    setOpen(false);
  }
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const rows = () => [
    ...(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []),
  ];

  const closeMenu = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    rows()[0]?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      // The click that follows this press must not reach what is underneath either.
      const swallow = (click: MouseEvent) => {
        click.preventDefault();
        click.stopPropagation();
      };
      document.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => document.removeEventListener("click", swallow, true), 600);
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = rows();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === "Tab") setOpen(false);
  };

  const choose = (select: () => void) => {
    closeMenu(true);
    select();
  };

  return (
    <span className={[`e-anchor`, align === "start" && "e-anchor--start", className].filter(Boolean).join(" ")}>
      {trigger({
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": id,
        onClick: () => setOpen((value) => !value),
        ref: triggerRef,
      })}
      <div
        ref={menuRef}
        id={id}
        role="menu"
        aria-label={label}
        className="e-menu"
        hidden={!open}
        onKeyDown={onKeyDown}
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (next && !menuRef.current?.contains(next) && !triggerRef.current?.contains(next)) setOpen(false);
        }}
      >
        {summary && open ? (
          <>
            <div className="e-menu__summary">{summary}</div>
            <div className="e-menu__separator" role="separator" />
          </>
        ) : null}
        {open &&
          items.map((item, index) => {
            if (item.kind === "separator") return <div key={index} className="e-menu__separator" role="separator" />;
            if (item.kind === "label")
              return (
                <div key={index} className="e-menu__label" role="presentation">
                  {item.label}
                </div>
              );
            if (item.kind === "link")
              return (
                <Link
                  key={index}
                  href={item.href}
                  role="menuitem"
                  tabIndex={-1}
                  className="e-menu__item"
                  onClick={(event) => {
                    item.onClick?.(event);
                    setOpen(false);
                  }}
                >
                  {item.icon ? <Icon name={item.icon} size="sm" /> : null}
                  {item.label}
                </Link>
              );
            if (item.kind === "choice")
              return (
                <button
                  key={index}
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.checked}
                  tabIndex={-1}
                  className="e-menu__item"
                  onClick={() => choose(item.onSelect)}
                >
                  {item.label}
                  <Icon name="check" size="sm" className="e-menu__check" />
                </button>
              );
            return (
              <button
                key={index}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={item.disabled || undefined}
                className={item.danger ? "e-menu__item e-menu__item--danger" : "e-menu__item"}
                onClick={() => {
                  if (!item.disabled) choose(item.onSelect);
                }}
              >
                {item.icon ? <Icon name={item.icon} size="sm" /> : null}
                {item.label}
              </button>
            );
          })}
      </div>
    </span>
  );
}
