import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/feedback";
import { NotFoundActions } from "@/components/workspace/not-found-actions";

// The root segment does not apply its own title template, so spell it out.
export const metadata: Metadata = { title: { absolute: "Page not found · Embel" } };

/** The page-error pattern: the Empty state layout with the danger visual. Signed in, Projects is the likelier way on. */
export default function NotFound() {
  return (
    <div className="page e-container e-page route-state">
      <section aria-labelledby="not-found-title">
        <EmptyState
          danger
          icon="circle-alert"
          headingLevel={1}
          title={<span id="not-found-title">Page not found</span>}
          text="This link may be old, or the page may have moved."
          action={<NotFoundActions />}
        />
      </section>
    </div>
  );
}
