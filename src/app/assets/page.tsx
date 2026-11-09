import type { Metadata } from "next";
import { AssetsWorkspace } from "@/components/assets/assets-workspace";

// The assets page appears as Library in the navigation.
export const metadata: Metadata = { title: "Library" };
export default function AssetsPage() { return <AssetsWorkspace />; }
