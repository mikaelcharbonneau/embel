import type { Metadata } from "next";
import { ProjectsWorkspace } from "@/components/workspace/projects-workspace";

export const metadata: Metadata = { title: "Projects" };
export default function BrandsPage() { return <ProjectsWorkspace />; }
