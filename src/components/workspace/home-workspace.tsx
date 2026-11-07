"use client";

import type { ProjectScope } from "@/domain/projects";
import { NewProjectForm } from "./project-editor";
import { HomeRecentBrands } from "./home-recent-brands";

export function HomeWorkspace({ initialScope = "complete_brand" }: { initialScope?: ProjectScope }) {
  return <div className="page home-page"><NewProjectForm initialScope={initialScope} home /><HomeRecentBrands /></div>;
}
