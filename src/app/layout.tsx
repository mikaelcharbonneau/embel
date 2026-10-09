import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { AppShell } from "@/components/workspace/app-shell";
import "@/styles/globals.css";
import "@/styles/project-naming.css";
import "@/styles/generation-activity.css";
import "@/styles/assets.css";
import "@/styles/identity-references.css";
import "@/styles/identity.css";
import "@/styles/concept-shell.css";
import "@/styles/home-concept.css";

export const metadata: Metadata = {
  title: { default: "Fluid — Brand workspace", template: "%s · Fluid" },
  description: "A considered workspace for your brand, from the first brief to the details.",
  icons: { icon: "/fluid-mark.svg" },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" className={GeistSans.variable}><body><AppShell>{children}</AppShell></body></html>;
}
