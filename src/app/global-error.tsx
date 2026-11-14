"use client";

import { useEffect, useRef } from "react";

// This replaces the root layout, including its providers, styles and fonts.
// Keep recovery independent of those dependencies and never display raw errors.
// Inline colors are the design system primitives (neutral-50 canvas, neutral-900 text) written out,
// because no stylesheet loads here.
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <html lang="en">
      <head>
        <title>Unable to load · Embel</title>
      </head>
      <body style={{ margin: 0, background: "#F7F7F5", color: "#191919", fontFamily: "system-ui, sans-serif" }}>
        <main style={{ boxSizing: "border-box", maxWidth: 620, margin: "10vh auto", padding: 24, lineHeight: 1.6 }}>
          <section role="alert" aria-labelledby="global-error-title">
            <p>Embel</p>
            <h1 ref={heading} tabIndex={-1} id="global-error-title" style={{ fontSize: 28, lineHeight: 1.2 }}>
              The workspace couldn’t load
            </h1>
            <p>Try again. If the problem continues, return to Home.</p>
            <p>
              Recent changes may not have saved. Returning to Home reloads the workspace and may lose unsaved changes.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
              <button
                type="button"
                onClick={() => retry()}
                style={{
                  font: "inherit",
                  minHeight: 44,
                  padding: "10px 18px",
                  border: "1px solid #191919",
                  borderRadius: 999,
                  background: "#191919",
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                Try again
              </button>
              {/* A real document navigation is intentional: the root router may have failed. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a href="/" style={{ color: "#191919", minHeight: 44, display: "inline-flex", alignItems: "center" }}>
                Back to Home
              </a>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
