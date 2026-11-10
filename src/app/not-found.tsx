import type { Metadata } from "next";
import Link from "next/link";

// The root segment does not apply its own title template, so spell it out.
export const metadata: Metadata = { title: { absolute: "Page not found · Embel" } };

export default function NotFound() {
  return (
    <div className="page route-state">
      <section aria-labelledby="not-found-title">
        <h1 id="not-found-title">Page not found</h1>
        <p>This link may be old, or the page may have moved.</p>
        <div className="route-state-actions">
          <Link className="button primary" href="/">
            Back to Home
          </Link>
        </div>
      </section>
    </div>
  );
}
