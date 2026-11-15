import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";

// The root segment does not apply its own title template, so spell it out.
export const metadata: Metadata = { title: { absolute: "Page not found · Embel" } };

/** The page-error pattern: the Empty state layout with the danger visual, and one way back. */
export default function NotFound() {
  return (
    <div className="page e-container e-page route-state">
      <section aria-labelledby="not-found-title">
        <EmptyState
          danger
          icon="circle-alert"
          headingLevel={1}
          title={<span id="not-found-title">Page not found</span>}
          action={
            <ButtonLink variant="primary" href="/">
              Back to Home
            </ButtonLink>
          }
        />
      </section>
    </div>
  );
}
