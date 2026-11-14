"use client";

import { ButtonLink } from "@/components/ui/button";
import { useAccountSession } from "./account-session";

/** The ways on from a page that doesn't exist: Projects first when signed in, and always Home. */
export function NotFoundActions() {
  const { session } = useAccountSession();
  return (
    <div className="e-cluster">
      {session.status === "ready" && (
        <ButtonLink variant="primary" href="/brands">
          Go to Projects
        </ButtonLink>
      )}
      <ButtonLink variant={session.status === "ready" ? "secondary" : "primary"} href="/">
        Back to Home
      </ButtonLink>
    </div>
  );
}
