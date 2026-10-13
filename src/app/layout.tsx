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
import "@/styles/assets-guided.css";
import "@/styles/trademarks-guided.css";
import "@/styles/settings-guided.css";
import "@/styles/auth-guided.css";
import "@/styles/project-workspace.css";

export const metadata: Metadata = {
  title: { default: "Embel — Brand workspace", template: "%s · Embel" },
  description: "A considered workspace for your brand, from the first brief to the details.",
  icons: { icon: "/embel-mark.svg" },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children, auth }: { children: React.ReactNode; auth: React.ReactNode }) {
  return <html lang="en" className={GeistSans.variable}><body><AppShell auth={auth}>{children}</AppShell></body></html>;
}
