import type { Metadata } from "next";
import { LogoCreationPage } from "@/components/logo-creation/logo-creation-page";
export const metadata: Metadata = { title: "Create a logo" };
export default function NewLogoPage() { return <LogoCreationPage />; }
