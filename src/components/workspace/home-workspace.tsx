"use client";

import { NewProjectForm } from "./project-editor";
import { HomeRecentBrands } from "./home-recent-brands";

export function HomeWorkspace() {
  return <div className="page home-page"><NewProjectForm initialScope="complete_brand" home /><HomeRecentBrands /></div>;
}
