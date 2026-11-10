import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { AppShell } from "@/components/workspace/app-shell";
import { siteDescription as description, siteTitle as title } from "./_brand/brand";
import "@/styles/globals.css";
import "@/styles/project-naming.css";
import "@/styles/generation-activity.css";
import "@/styles/assets.css";
import "@/styles/identity-references.css";
import "@/styles/identity.css";
import "@/styles/concept-shell.css";
import "@/styles/home-concept.css";
import "@/styles/assets-guided.css";
import "@/styles/settings-guided.css";
import "@/styles/auth-guided.css";
import "@/styles/project-workspace.css";
import "@/styles/guided-interview.css";
import "@/styles/guided-conversation.css";
import "@/styles/journey-conversation.css";

// Icons and the social preview image come from the file conventions beside this
// layout: icon.svg, apple-icon.tsx and opengraph-image.tsx.
export const metadata: Metadata = {
  title: { default: title, template: "%s · Embel" },
  description,
  openGraph: { type: "website", siteName: "Embel", title, description },
  twitter: { card: "summary_large_image", title, description },
  robots: { index: false, follow: false },
};

// The browser chrome matches the page canvas (--canvas in tokens.css).
export const viewport: Viewport = { themeColor: "#F7F7F5" };

export default function RootLayout({ children, auth }: { children: React.ReactNode; auth: React.ReactNode }) {
  return (
    <html lang="en" className={GeistSans.variable}>
      <body>
        <AppShell auth={auth}>{children}</AppShell>
      </body>
    </html>
  );
}
