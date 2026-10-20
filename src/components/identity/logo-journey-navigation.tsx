import Link from "next/link";
import { logoUuidSchema } from "@/domain/logo-vector";
export type LogoJourneyStage = "inspiration" | "concepts" | "board" | "vector" | "directions" | "systems";
const stages = [
  { key: "inspiration", path: "/inspiration", label: "Inspiration" },
  { key: "concepts", path: "/logo", label: "Logo concepts" },
  { key: "board", path: "/brand-board", label: "Brand board" },
  { key: "vector", path: "/logo/vector", label: "Vector review" },
  { key: "directions", path: "/logo/directions", label: "Identity directions" },
  { key: "systems", path: "/identity", label: "Moodboard & systems" },
] as const;
export function LogoJourneyNavigation({ projectId, current }: { projectId: string; current: LogoJourneyStage }) {
  const parsed = logoUuidSchema.safeParse(projectId);
  if (!parsed.success) return null;
  return <nav aria-label="Logo and identity pages" className="logo-journey-navigation">{stages.map(stage => <Link key={stage.key} href={`/brands/account/${parsed.data}${stage.path}`} className="text-link" aria-current={current === stage.key ? "page" : undefined}>{stage.label}</Link>)}</nav>;
}
