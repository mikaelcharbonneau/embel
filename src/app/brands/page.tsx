import type { Metadata } from "next";
import { BrandsWorkspace } from "@/components/workspace/home-workspace";

export const metadata: Metadata = { title: "Brands" };
export default function BrandsPage() { return <BrandsWorkspace />; }
