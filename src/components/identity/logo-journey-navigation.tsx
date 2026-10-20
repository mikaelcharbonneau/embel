import Link from "next/link";
import { logoUuidSchema } from "@/domain/logo-vector";
import type { ProjectScope } from "@/domain/projects";
/** Both project navigation rows follow the same saved-edit and scope policy. */
export function visualProjectNavigationLock({ checking = false, checkingReason = "Checking saved project…", dirty = false, scope = "complete_brand" }: { checking?: boolean; checkingReason?: string; dirty?: boolean; scope?: ProjectScope }) {
  return checking ? checkingReason : dirty ? "Save or resolve your project edits first" : scope === "naming_only" ? "Expand the project scope first" : null;
}
export type LogoJourneyStage = "inspiration" | "concepts" | "board" | "vector" | "directions" | "systems";
const stages = [
  { key: "inspiration", path: "/inspiration", label: "Inspiration" },
  { key: "concepts", path: "/logo", label: "Logo concepts" },
  { key: "board", path: "/brand-board", label: "Brand board" },
  { key: "vector", path: "/logo/vector", label: "Vector review" },
  { key: "directions", path: "/logo/directions", label: "Identity directions" },
  { key: "systems", path: "/identity", label: "Moodboard & systems" },
] as const;
export function LogoJourneyNavigation({ projectId, current, checking = false, checkingReason, dirty = false, scope = "complete_brand" }: { projectId: string; current: LogoJourneyStage; checking?: boolean; checkingReason?: string; dirty?: boolean; scope?: ProjectScope }) {
  const parsed = logoUuidSchema.safeParse(projectId);
  if (!parsed.success) return null;
  const locked = visualProjectNavigationLock({ checking, checkingReason, dirty, scope });
  return <nav aria-label="Logo and identity pages" className="logo-journey-navigation">{stages.map(stage => locked
    ? <button key={stage.key} type="button" disabled title={locked} className="text-link" aria-current={current === stage.key ? "page" : undefined}>{stage.label}</button>
    : <Link key={stage.key} href={`/brands/account/${parsed.data}${stage.path}`} className="text-link" aria-current={current === stage.key ? "page" : undefined}>{stage.label}</Link>)}</nav>;
}
