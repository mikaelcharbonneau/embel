"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { identityReferenceUploadSchema } from "@/domain/identity-reference-uploads";
import type { IdentityReferenceEntry, ReferenceElement } from "@/domain/identity-references";
import { createAccountIdentityClient } from "./account-identity-client";
import { createAccountLogoClient } from "./account-logo-client";
import type { IdentityReferenceUploadDraft } from "./identity-draft-memory";

export type ReferenceUploadMetadata = {
  label: string;
  creator: string | null;
  sourceUrl: string | null;
  rightsNote: string;
  relevantElements: ReferenceElement[];
  tags: string[];
};
export type ReferenceUploadRetry = "upload" | "registration" | "rejected" | null;

/** Explicit owned uploads use the same verified raster publication as Logo.
 * Finishing a publication never chooses reference reactions for the customer.
 * One upload runs at a time per project; an unconfirmed one is retained in
 * account memory (never storage) until it is checked, finished or cancelled. */
export function useReferenceUpload({
  account,
  projectId,
  blocked,
  onSaved,
}: {
  account: VerifiedAccount;
  projectId: string;
  blocked: boolean;
  onSaved(): void;
}) {
  const { isCurrent, expire, identityDrafts } = useAccountSession();
  const identity = useMemo(
    () => createAccountIdentityClient(account, projectId, isCurrent, expire),
    [account, projectId, isCurrent, expire],
  );
  const retained = useSyncExternalStore(
    identityDrafts.subscribe,
    () => identityDrafts.referenceUpload(account.userId, projectId),
    () => null,
  );
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<string | null>(null),
    [retry, setRetry] = useState<ReferenceUploadRetry>(null);
  useEffect(() => {
    identity.activate();
    return () => {
      active.current?.abort();
      identity.dispose();
    };
  }, [identity]);
  async function verify(entry: IdentityReferenceEntry, original: IdentityReferenceUploadDraft, signal: AbortSignal) {
    const digest = await crypto.subtle.digest("SHA-256", await original.file.arrayBuffer());
    const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    if (!identity.current()) return false;
    if (signal.aborted) throw new Error("Reference request timed out");
    if (
      entry.reference.media.contentHash !== hash ||
      entry.reference.media.mimeType !== original.file.type ||
      JSON.stringify(entry.reference.attribution) !== JSON.stringify(original.input.metadata.attribution) ||
      JSON.stringify(entry.reference.relevantElements) !== JSON.stringify(original.input.metadata.relevantElements) ||
      JSON.stringify(entry.reference.tags) !== JSON.stringify(original.input.metadata.tags)
    )
      throw new Error("Reference receipt mismatch");
    identityDrafts.resolveReferenceUpload(account.userId, projectId, original.input.upload.requestKey);
    setRetry(null);
    setNotice("Reference saved. Choose Ensemble or individual elements to use it in your next system.");
    onSaved();
    return true;
  }
  /** Runs one request at a time with a 60-second limit; true only once saved and verified. */
  async function run(work: (signal: AbortSignal) => Promise<boolean | void>) {
    if (active.current || !identity.current()) return false;
    const controller = new AbortController();
    active.current = controller;
    const timeout = setTimeout(() => controller.abort(), 60_000);
    setBusy(true);
    setNotice(null);
    setRetry(null);
    try {
      return (await work(controller.signal)) === true;
    } catch {
      if (identity.current())
        setNotice(
          "The reference upload could not be confirmed. Your original file and attribution are kept here. Check the original upload before retrying.",
        );
      return false;
    } finally {
      clearTimeout(timeout);
      if (active.current === controller) {
        active.current = null;
        if (identity.current()) setBusy(false);
      }
    }
  }
  async function upload(file: File, metadata: ReferenceUploadMetadata) {
    if (retained || blocked || !file.size) return false;
    return run(async (signal) => {
      const logo = createAccountLogoClient(account, projectId, isCurrent, expire);
      const workspace = await logo.getLogoWorkspace(signal).finally(() => logo.dispose());
      if (!identity.current()) return false;
      if (!workspace || signal.aborted) throw new Error("Workspace unavailable");
      const { relevantElements, tags, ...attribution } = metadata;
      const parsed = identityReferenceUploadSchema.safeParse({
        upload: {
          requestKey: crypto.randomUUID(),
          expected: workspace.heads,
          aspects: ["overall_feel"],
          rightsDeclaration: attribution.rightsNote,
        },
        metadata: { attribution, relevantElements, tags },
      });
      if (!parsed.success) {
        setNotice("Check the attribution, source URL and permission declaration before uploading.");
        return false;
      }
      const original = { ownerId: account.userId, projectId, input: parsed.data, file };
      if (!identityDrafts.retainReferenceUpload(original)) {
        setNotice(
          "The file could not be retained safely. Use a PNG, JPEG or WebP up to 32 MiB and resolve pending uploads first.",
        );
        return false;
      }
      const entry = await identity.uploadReference(parsed.data, file, signal);
      if (!identity.current()) return false;
      if (!entry || signal.aborted) throw new Error("Upload unconfirmed");
      return verify(entry, original, signal);
    });
  }
  async function check() {
    if (!retained) return false;
    return run(async (signal) => {
      const found = await identity.referenceUpload(retained.input.upload.requestKey, signal);
      if (!identity.current()) return false;
      if (!found || signal.aborted) throw new Error("Upload status unavailable");
      if (found.status === "registered") return verify(found.entry, retained, signal);
      const value = found.upload;
      if (value.status === "rejected") {
        setRetry("rejected");
        setNotice(
          "The upload was rejected because its saved inputs changed or it was cancelled. Your file and attribution are kept; you can discard this rejected upload and try again.",
        );
        return false;
      }
      if (value.status !== "not_found" && JSON.stringify(value.request.input) !== JSON.stringify(retained.input.upload))
        throw new Error("Original upload mismatch");
      setRetry(value.status === "succeeded" ? "registration" : "upload");
      setNotice(
        value.status === "succeeded"
          ? "The verified file is saved. Finish adding its original attribution to Identity."
          : "The original upload has not completed. Retry the same file and request without creating another reference.",
      );
      return false;
    });
  }
  async function cancel() {
    if (!retained) return false;
    return run(async (signal) => {
      const result = await identity.cancelReferenceUpload(retained.input, retained.file, signal);
      if (!identity.current()) return false;
      if (!result || signal.aborted) throw new Error("Upload cancellation unconfirmed");
      if (result.status === "rejected") {
        identityDrafts.resolveReferenceUpload(account.userId, projectId, retained.input.upload.requestKey);
        setNotice(
          "The original upload is cancelled. You can review the form and upload again using the latest saved project.",
        );
        return false;
      }
      if (result.status !== "succeeded") throw new Error("Upload cancellation not final");
      setRetry("registration");
      setNotice(
        "The file was already saved. Finish its original Identity reference registration; it has not been discarded.",
      );
      return false;
    });
  }
  function discardRejected() {
    if (!retained) return;
    identityDrafts.resolveReferenceUpload(account.userId, projectId, retained.input.upload.requestKey);
    setRetry(null);
    setNotice("The rejected upload has been discarded. Your saved references are unchanged.");
  }
  async function retryOriginal() {
    if (!retained || !retry || retry === "rejected") return false;
    const mode = retry;
    return run(async (signal) => {
      const entry = await identity.uploadReference(
        retained.input,
        mode === "registration" ? null : retained.file,
        signal,
      );
      return entry ? verify(entry, retained, signal) : false;
    });
  }
  return { retained, busy, notice, setNotice, retry, upload, check, cancel, discardRejected, retryOriginal };
}
export type ReferenceUploadController = ReturnType<typeof useReferenceUpload>;
