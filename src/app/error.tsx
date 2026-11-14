"use client";

import { useEffect, useRef } from "react";

import Link from "next/link";
import { buttonClass } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

// This boundary is below the root layout, so the account provider and navigation
// stay mounted. Do not clear recovery buffers or automatically retry here.
// The page-error pattern: the Empty state layout with the danger visual, like the 404 page.
export default function RouteError({ retry }: { error: unknown; retry: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <div className="page e-container e-page route-state">
      <section className="e-empty" role="alert" aria-labelledby="route-error-title">
        <span className="e-empty__visual e-empty__visual--danger" aria-hidden="true">
          <Icon name="triangle-alert" size="lg" />
        </span>
        <h1 ref={heading} tabIndex={-1} id="route-error-title" className="e-empty__title">
          This page couldn’t load
        </h1>
        <p className="e-empty__text">
          Try again, or return to Home if the problem continues. Recent changes may not have saved. Try again before
          leaving or reloading the page.
        </p>
        <div className="e-empty__action e-cluster">
          <button type="button" className={buttonClass({ variant: "primary" })} onClick={() => retry()}>
            Try again
          </button>
          <Link className={buttonClass({ variant: "secondary" })} href="/" prefetch={false}>
            Back to Home
          </Link>
        </div>
      </section>
    </div>
  );
}
