"use client";

import { useState } from "react";
import { ProjectReferencesWorkspace, type ReferenceStateHint } from "@/components/identity/project-references-workspace";
import { ProjectIdentityWorkspace } from "@/components/identity/project-identity";

export function ProjectIdentityPageWorkspace({ projectId }: { projectId: string }) {
  const [referenceState, setReferenceState] = useState<ReferenceStateHint>();
  return (
    <ProjectReferencesWorkspace projectId={projectId} onReferenceStateChange={setReferenceState}>
      <div className="identity-transition"><a className="identity-secondary-button" href="#project-identity-title">View saved systems</a></div>
      <ProjectIdentityWorkspace projectId={projectId} referenceState={referenceState} />
    </ProjectReferencesWorkspace>
  );
}
