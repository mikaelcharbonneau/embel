import { AppMark } from "@/components/ui/app-mark";

/** Embel's avatar and name above a reply, with the journey part when known,
 * e.g. "Embel · Logo · 2 of 3". */
export function EmbelIdentity({ label }: { label?: string }) {
  return (
    <div className="guided-assistant-identity">
      <span className="guided-assistant-avatar" aria-hidden="true">
        <AppMark />
      </span>
      <span className="guided-assistant-label">{label ? `Embel · ${label}` : "Embel"}</span>
    </div>
  );
}
