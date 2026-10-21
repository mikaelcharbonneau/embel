"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon, type IconName } from "@/components/ui/icon";
import type { ProjectScope } from "@/domain/projects";

// Presentation labels do not expand the server's three validated project scopes.
const scopes: { label: string; icon: IconName; value?: ProjectScope; unavailable?: string }[] = [
  { label: "Brand", icon: "brands", value: "complete_brand" },
  { label: "Name", icon: "pencil", value: "naming_only" },
  { label: "System", icon: "layers", value: "visual_identity_only" },
  { label: "Logo", icon: "assets", unavailable: "Use Projects → New project → Create a logo for the dedicated logo workflow." },
  { label: "Font", icon: "names", unavailable: "Standalone font creation is not available yet." },
  { label: "Color", icon: "palette", unavailable: "Standalone color creation is not available yet." },
  { label: "Guide", icon: "file", unavailable: "Standalone guide creation is not available yet." },
];

export function HomeScopePicker({ value, onChange, disabled = false }: {
  value: ProjectScope; onChange(value: ProjectScope): void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const selected = scopes.find(option => option.value === value)!;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function keyboard(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (!open) { if (!disabled) setOpen(true); return; }
    const options = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)') ?? [])];
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  }
  return <div className="home-scope" ref={root} onKeyDown={keyboard} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className="home-scope-trigger" aria-label={`Project scope: ${selected.label}`} aria-haspopup="menu" aria-expanded={open && !disabled} aria-controls={id} disabled={disabled} onClick={() => setOpen(!open)}>
      <Icon name={selected.icon} size={22} /><span>{selected.label}</span><Icon name="chevron" size={14} className="home-scope-chevron" />
    </button>
    {open && !disabled && <div className="home-scope-menu" id={id} role="menu" aria-label="Project scope">
      {scopes.map(option => <button key={option.label} type="button" role="menuitemradio" aria-checked={option.value === value} disabled={!option.value} title={option.unavailable} aria-describedby={option.unavailable ? `${id}-${option.label}-availability` : undefined} onClick={() => {
        if (option.value) { onChange(option.value); setOpen(false); trigger.current?.focus(); }
      }}><Icon name={option.icon} size={20} /><span>{option.label}</span>{option.value === value && <Icon name="check" size={16} />}{!option.value && <small>{option.label === "Logo" ? "In Projects" : "Unavailable"}</small>}</button>)}
    </div>}
    {scopes.filter(option => option.unavailable).map(option => <span className="sr-only" key={option.label} id={`${id}-${option.label}-availability`}>{option.unavailable}</span>)}
  </div>;
}
