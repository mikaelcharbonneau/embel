"use client";

import { useEffect, useRef } from "react";

// This replaces the root layout, including its providers, styles and fonts.
// Keep recovery independent of those dependencies and never display raw errors.
// Inline colors are the design system primitives (neutral-50 canvas, neutral-900 text) written out,
// because no stylesheet loads here.
// The Embel mark's eight paths (public/embel-mark.svg), so the crash screen carries it without loading a file.
const MARK_PATHS = [
  "M130.98 891L385.03 890.97L385.01 1145.06L130.96 1145.07L130.98 891Z",
  "M892.06 890.99L1145.96 890.98L1146 1145.06L892.06 1145.07L892.06 890.99Z",
  "M512.05 1018.03L765.99 1018.02L766.04 1272.05L512.05 1272.07L512.05 1018.03Z",
  "M130.95 130.111C158.75 129.381 189.53 130.035 217.52 130.034L385.03 130.036L385.04 383.953L130.96 383.979L130.95 130.111Z",
  "M512.05 3.05701L766 3.036L766.02 194.24C766.02 201.558 766.94 252.768 765.57 257.028L512.05 257.038L512.05 3.05701Z",
  "M892.05 130.069C920.33 129.724 949.28 130.041 977.6 130.039L1145.97 130.033L1145.99 383.962L892.05 383.983L892.05 130.069Z",
  "M4.01001 510.975L257.98 510.955L258 763.97L4 763.97C3.56006 734.82 3.96997 704.521 3.96997 675.293L4.01001 510.975Z",
  "M1019.03 510.976L1272.96 510.959L1272.96 679.229L1272.99 733.417C1273 742.734 1273.33 754.797 1272.8 763.965L1019.03 763.97C1018.62 735.299 1019 705.628 1019 676.889L1019.03 510.976Z",
];

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
            <svg width="32" height="32" viewBox="0 0 1276 1276" fill="#191919" aria-hidden="true" focusable="false">
              {MARK_PATHS.map((d) => (
                <path key={d} d={d} />
              ))}
            </svg>
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
