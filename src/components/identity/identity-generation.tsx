"use client";

import Link from "next/link";
import type { ProjectIdentityController } from "./use-project-identity";

/** Older saved systems remain accessible; all new boards use the chosen-logo flow. */
export function IdentityGeneration({ identity }: { identity: Pick<ProjectIdentityController, "overview"> }) {
  const projectId = identity.overview?.projectId;
  return <section className="identity-generation-gate" aria-label="Visual directions">
    <h3>Visual directions</h3>
    <p>Use your chosen logo to compare three brand boards, then create your brand assets.</p>
    {projectId && <Link className="identity-primary-button" href={`/brands/account/${projectId}/logo/directions`}>Open visual directions</Link>}
  </section>;
}
