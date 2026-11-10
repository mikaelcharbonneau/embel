"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { IdentityGenerationIntent } from "@/domain/identity-jobs";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { AccountIdentityClient } from "./account-identity-client";
import type { IdentityDraftMemory } from "./identity-draft-memory";
import {
  createIdentityGenerationController,
  EMPTY_IDENTITY_GENERATION,
  identityBatchActive,
} from "./identity-generation-controller";

const noSubscription = () => () => {},
  empty = () => EMPTY_IDENTITY_GENERATION;
export function useIdentityGeneration({
  account,
  projectId,
  client,
  memory,
  canStart,
  onResults,
}: {
  account: VerifiedAccount | null;
  projectId: string;
  client: AccountIdentityClient | null;
  memory: IdentityDraftMemory;
  canStart(input: IdentityGenerationIntent): boolean;
  onResults(): void;
}) {
  const controller = useMemo(
    () =>
      account && client
        ? createIdentityGenerationController({ account, projectId, client, memory, canStart: () => false })
        : null,
    [account, projectId, client, memory],
  );
  useLayoutEffect(() => {
    controller?.setPrerequisites(canStart);
  }, [controller, canStart]);
  const state = useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.getSnapshot ?? empty,
    controller?.getServerSnapshot ?? empty,
  );
  useEffect(() => {
    if (!controller) return;
    controller.activate();
    const start = window.setTimeout(() => {
      void controller.refresh();
    }, 0);
    return () => {
      window.clearTimeout(start);
      controller.dispose();
    };
  }, [controller]);
  useEffect(() => {
    if (!controller || !identityBatchActive(state.batch)) return;
    let closed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (!closed && document.visibilityState === "visible")
        timer = setTimeout(() => {
          void poll();
        }, 2500);
    };
    async function poll() {
      if (closed) return;
      await controller!.poll();
      if (identityBatchActive(controller!.getSnapshot().batch)) arm();
    }
    function visibility() {
      clearTimeout(timer);
      if (document.visibilityState === "visible") void poll();
    }
    arm();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      closed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [controller, state.batch]);
  const resultsChanged = useEffectEvent(onResults);
  const resultsKey = state.batch?.systems.length
    ? `${state.batch.batchId}:${state.batch.systems.map((system) => system.id).join(":")}`
    : "";
  useEffect(() => {
    if (resultsKey) resultsChanged();
  }, [resultsKey]);
  return { ...state, controller };
}
export type IdentityGenerationView = ReturnType<typeof useIdentityGeneration>;
