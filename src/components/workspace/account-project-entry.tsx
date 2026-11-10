"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { accountProjectResponseSchema } from "@/domain/project-api";
import { createAccountLogoClient } from "@/components/identity/account-logo-client";
import { createAccountIdentityClient } from "@/components/identity/account-identity-client";
import { logoWorkspaceV2Schema } from "@/domain/logo-workspace";
import { projectStrategyHref } from "@/domain/project-handoff";
import { AccountRequestError } from "./account-api";
import { needsStrategyRecovery, reconcileAccountWorkspace } from "./account-draft-memory";
import { boundedAccountRequest } from "./bounded-account-request";
import { AccountProjectEditor } from "./account-project-editor";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "./account-session";
import { readProjectContinuation } from "./project-continuation";

const empty = () => null;

/** Generic project links resume saved work. Explicit Strategy links still open
 * its editor, including recovery for drafts that must not be navigated away. */
export function AccountProjectEntry({ projectId, view }: { projectId: string; view?: string }) {
  const { session } = useAccountSession();
  if (!z.uuid().safeParse(projectId).success) return <AccountProjectEditor projectId={projectId} />;
  if (view === "strategy")
    return (
      <AccountProjectEditor
        projectId={projectId}
        navigation={
          <nav className="project-read-notice" aria-label="Project navigation">
            <Link className="text-link" href={`/brands/account/${projectId}`}>
              Return to saved work
            </Link>
          </nav>
        }
      />
    );
  if (session.status !== "ready")
    return (
      <div className="page">
        <h1>Account project</h1>
        <AccountStatus />
        <Link href="/brands">Back to projects</Link>
      </div>
    );
  return (
    <OwnedProjectEntry
      key={`${session.userId}:${session.generation}:${projectId}`}
      account={session}
      projectId={projectId}
    />
  );
}

function OwnedProjectEntry({ account, projectId }: { account: VerifiedAccount; projectId: string }) {
  const { drafts, isCurrent, expire } = useAccountSession(),
    router = useRouter();
  const retained = useSyncExternalStore(drafts.subscribe, () => drafts.get(projectId), empty);
  const owned =
    retained?.ownerId === account.userId &&
    retained.generation === account.generation &&
    retained.saved.id === projectId
      ? retained
      : null;
  const [keepStrategy, setKeepStrategy] = useState(() => needsStrategyRecovery(owned));
  const [destination, setDestination] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Once an editor is kept for recovery, saving it must not replace the focused
  // editor with a new routing read. A later generic visit can resume the saved workspace.
  if (!keepStrategy && needsStrategyRecovery(owned)) setKeepStrategy(true);

  useEffect(() => {
    if (keepStrategy) return;
    const controller = new AbortController();
    const logo = createAccountLogoClient(account, projectId, isCurrent, expire);
    const clients = {
      logo: {
        ...logo,
        async getLogoWorkspace(signal = controller.signal) {
          const workspace = await boundedAccountRequest(`/api/projects/${projectId}/logo`, logoWorkspaceV2Schema, {
            signal,
            expectedOwnerId: account.userId,
          });
          if (workspace.ownerId !== account.userId || workspace.projectId !== projectId)
            throw new AccountRequestError(401);
          return workspace;
        },
      },
      identity: createAccountIdentityClient(account, projectId, isCurrent, expire),
    };
    const current = () => !controller.signal.aborted && isCurrent(account);
    const needsStrategy = () => {
      const latest = drafts.get(projectId);
      return (
        /^#strategy(?:-|$)/u.test(window.location.hash) ||
        Boolean(
          latest?.ownerId === account.userId &&
          latest.generation === account.generation &&
          needsStrategyRecovery(latest),
        )
      );
    };
    const deadline = setTimeout(() => {
      if (current()) setFailed(true);
      controller.abort();
    }, 30_000);
    async function read() {
      // Old bookmarked review anchors remain explicit Strategy destinations.
      if (needsStrategy()) {
        setKeepStrategy(true);
        return;
      }
      try {
        const { project } = await boundedAccountRequest(`/api/projects/${projectId}`, accountProjectResponseSchema, {
          signal: controller.signal,
          expectedOwnerId: account.userId,
        });
        if (!current()) return;
        if (project.owner_id !== account.userId || project.id !== projectId) {
          expire(account);
          return;
        }
        if (!drafts.set(reconcileAccountWorkspace(drafts.get(projectId), project, account.generation)))
          throw new AccountRequestError(409);
        if (needsStrategy()) {
          setKeepStrategy(true);
          return;
        }
        const action = await readProjectContinuation(project, clients, controller.signal);
        if (!current()) return;
        if (needsStrategy()) {
          setKeepStrategy(true);
          return;
        }
        if (drafts.get(projectId)?.saved.current_revision !== project.current_revision)
          throw new AccountRequestError(409);
        setDestination(action.href);
        router.replace(action.href);
      } catch (error) {
        if (!current()) return;
        if (error instanceof AccountRequestError && error.status === 401) expire(account);
        else setFailed(true);
      }
    }
    void read().finally(() => clearTimeout(deadline));
    return () => {
      clearTimeout(deadline);
      controller.abort();
      logo.dispose();
      clients.identity.dispose();
    };
  }, [account, projectId, keepStrategy, attempt, drafts, isCurrent, expire, router]);

  if (!isCurrent(account)) return null;
  if (keepStrategy || needsStrategyRecovery(owned)) return <AccountProjectEditor projectId={projectId} />;
  return (
    <div className="page">
      <h1>Opening your project</h1>
      {failed ? (
        <div role="alert">
          <p>Your saved work could not be checked. Try again, or open Strategy to review the project.</p>
          <button
            className="button secondary"
            type="button"
            onClick={() => {
              setFailed(false);
              setDestination(null);
              setAttempt((value) => value + 1);
            }}
          >
            Try opening again
          </button>
          <Link className="text-link" href={projectStrategyHref(projectId)}>
            Open Strategy
          </Link>
        </div>
      ) : (
        <p role="status">
          {destination ? (
            <>
              Opening your saved workspace… <Link href={destination}>Continue to workspace</Link>
            </>
          ) : (
            "Checking your saved work…"
          )}
        </p>
      )}
    </div>
  );
}
