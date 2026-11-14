"use client";

import type { ReactNode } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState, LoadingRegion, Skeleton } from "@/components/ui/feedback";
import { useProjectHeader } from "@/components/journey/project-header";
import { AccountStatus, useAccountSession } from "./account-session";

/**
 * What a brand page shows before its saved work is on screen: a neutral frame while the account or the project is
 * read (no instructions, no signed-out wording), the page error when the project can't be opened, and the account
 * notice when there is no verified account.
 */
export function ProjectOpening() {
  return (
    <div className="page e-container e-page project-opening">
      <h1 className="e-sr">Opening your brand</h1>
      <LoadingRegion label="Opening your brand">
        <div className="e-stack e-stack--md">
          <Skeleton shape="title" width={40} />
          <Skeleton shape="line" width={80} />
          <Skeleton shape="line" width={60} />
          <Skeleton shape="block" />
        </div>
      </LoadingRegion>
    </div>
  );
}

/** The page error for a brand that can't be opened: what happened, the one way to try again and the way back. The
 * project bar returns to the app's navigation, since there is no brand to show in it. */
export function ProjectUnavailable({
  projectId,
  reason,
  note,
  onRetry,
  retryLabel = "Try again",
}: {
  projectId: string;
  /** What happened, in the person's terms. */
  reason: ReactNode;
  /** A second sentence, such as edits kept in this tab. */
  note?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  useProjectHeader({ projectId, projectName: "", steps: [], saveState: null, unavailable: true });
  return (
    <div className="page e-container e-page project-unavailable" role="alert">
      <EmptyState
        danger
        icon="triangle-alert"
        headingLevel={1}
        title="We couldn’t open this brand"
        text={
          <>
            {reason}
            {note ? <> {note}</> : null}
          </>
        }
        action={
          <div className="e-cluster">
            {onRetry && (
              <Button variant="primary" icon="rotate-ccw" onClick={onRetry}>
                {retryLabel}
              </Button>
            )}
            <ButtonLink href="/brands">Back to Projects</ButtonLink>
          </div>
        }
      />
    </div>
  );
}

/** A brand page without a verified account: the neutral frame while the account is checked or a sign-in runs, the
 * account notice (sign in, or check again) once the check has answered. */
export function ProjectAccountState({ retainedEdits = false }: { retainedEdits?: boolean }) {
  const { session, signingIn, signingOut } = useAccountSession();
  if (session.status === "checking" || signingIn || signingOut) return <ProjectOpening />;
  return (
    <div className="page e-container e-page">
      <h1 className="e-sr">Your brand</h1>
      <AccountStatus retainedEdits={retainedEdits} signedOut="Sign in to open this brand." />
    </div>
  );
}
