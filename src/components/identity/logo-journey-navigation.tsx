import Link from "next/link";
import { logoUuidSchema } from "@/domain/logo-vector";
export type LogoJourneyStage = "concepts" | "editor" | "directions" | "deliverables";
const stages = [
  { key: "concepts", path: "", label: "Logo concepts" },
  { key: "editor", path: "/editor", label: "Refine logo" },
  { key: "directions", path: "/directions", label: "Identity" },
  { key: "deliverables", path: "/deliverables", label: "Brand files" },
] as const;
export function LogoJourneyNavigation({ projectId, current }: { projectId: string; current: LogoJourneyStage }) {
  const parsed = logoUuidSchema.safeParse(projectId);
  if (!parsed.success) return null;
  return <nav aria-label="Logo and identity stages" className="logo-journey-navigation">{stages.map(stage => <Link key={stage.key} href={`/brands/account/${parsed.data}/logo${stage.path}`} className="text-link" aria-current={current === stage.key ? "page" : undefined}>{stage.label}</Link>)}</nav>;
}
