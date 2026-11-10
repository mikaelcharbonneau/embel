"use client";

import { useEffect, useRef } from "react";

import Link from "next/link";

// This boundary is below the root layout, so the account provider and navigation
// stay mounted. Do not clear recovery buffers or automatically retry here.
export default function RouteError({ retry }: { error: unknown; retry: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <div className="page route-state">
      <section role="alert" aria-labelledby="route-error-title">
        <h1 ref={heading} tabIndex={-1} id="route-error-title">
          This page couldn’t load
        </h1>
        <p>Try again, or return to Home if the problem continues.</p>
        <p>Recent changes may not have saved. Try again before leaving or reloading the page.</p>
        <div className="route-state-actions">
          <button type="button" className="button primary" onClick={() => retry()}>
            Try again
          </button>
          <Link className="button secondary" href="/" prefetch={false}>
            Back to Home
          </Link>
        </div>
      </section>
    </div>
  );
}
