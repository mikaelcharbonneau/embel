"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { useOptionalAccountSession } from "@/components/workspace/account-session";
import { AccountRequestError } from "@/components/workspace/account-api";
import { createAccountLifecycleClient } from "@/components/workspace/account-lifecycle-client";
import { boundedAccountRequest } from "@/components/workspace/bounded-account-request";
import {
  attachmentMimeTypeSchema,
  type AttachmentPolicy,
  type DraftAttachment,
  type StageHomeAttachmentInput,
} from "@/domain/attachments";
import { BRIEF_FILE_MAX, briefFilesResponseSchema } from "@/domain/brief-files";
import type { HomeAttachmentAvailability } from "./attachment-draft";

// Attaching files in a brand's side chat (docs/home-prompt-inputs.md). Chosen files wait in the reply
// box; on Send they are uploaded and verified (the same upload as on Home), added to the brand, and
// read by Embel (kind brief.read_files, no credits) before the typed message goes out.

const READ_KIND = "brief.read_files";
/** How long Send waits for the reading before the message goes out anyway. */
const READ_WAIT_MS = 200_000,
  READ_POLL_MS = 2_500;
const runsSchema = z.object({ runs: z.array(z.object({ id: z.string(), status: z.string() })) });
const startedSchema = z.object({ run: z.object({ id: z.string(), status: z.string() }) });

type ChatFile = {
  localId: string;
  file: File;
  upload: StageHomeAttachmentInput;
  state: DraftAttachment["state"];
  id: string | null;
};
export type ChatAttachments = {
  files: DraftAttachment[];
  policy: AttachmentPolicy | null;
  availability: HomeAttachmentAvailability;
  /** Uploading or reading: the reply box holds its text and buttons meanwhile. */
  busy: boolean;
  /** What is happening, for the reply box's status line. */
  status: string | null;
  error: string | null;
  /** Goes up each time the brand's files change, so its file list reads again. */
  revision: number;
  /** Embel is reading files added here. */
  reading: boolean;
  add(files: readonly File[]): Promise<void>;
  remove(localId: string): void;
  /** Uploads, adds and has the files read. False when they could not be added: nothing is sent then. */
  flush(): Promise<boolean>;
};

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, "0")).join("");

export function useChatAttachments(projectId: string): ChatAttachments {
  const shared = useOptionalAccountSession();
  const account = shared?.session.status === "ready" ? shared.session : null;
  const client = useMemo(
    () => (account && shared ? createAccountLifecycleClient(account, shared.isCurrent, shared.expire) : null),
    [account, shared],
  );
  const [capability, setCapability] = useState<{ policy: AttachmentPolicy | null; reason: string | null } | null>(null);
  const [held, setHeld] = useState<number | null>(null);
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [phase, setPhase] = useState<"idle" | "uploading" | "reading">("idle");
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const latest = useRef<ChatFile[]>([]);
  useEffect(() => {
    latest.current = files;
  });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    void client
      .getHomeAttachmentCapability(controller.signal)
      .then((result) => {
        if (result && !controller.signal.aborted) setCapability({ policy: result.policy, reason: result.reason });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setCapability({ policy: null, reason: "Files can’t be added right now. Your message is kept." });
      });
    return () => controller.abort();
  }, [client]);
  useEffect(() => {
    // How many files the brand already has decides how many more fit.
    if (!client) return;
    const controller = new AbortController();
    void boundedAccountRequest(`/api/projects/${projectId}/brief-files`, briefFilesResponseSchema, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setHeld(result.files.length);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, projectId, revision]);

  const room = held === null ? null : Math.max(0, BRIEF_FILE_MAX - held);
  const policy = useMemo(
    () =>
      capability?.policy && room
        ? { ...capability.policy, maxFiles: Math.max(1, Math.min(capability.policy.maxFiles, room)) }
        : null,
    [capability, room],
  );
  const availability: HomeAttachmentAvailability = policy
    ? { status: "available" }
    : {
        status: "unavailable",
        reason:
          room === 0
            ? `This brand already has ${BRIEF_FILE_MAX} files, the most it can hold.`
            : (capability?.reason ?? "Checking whether files can be added…"),
      };
  const busy = phase !== "idle";

  const add = useCallback(
    async (selected: readonly File[]) => {
      if (busy) return;
      setError(null);
      const next: ChatFile[] = [];
      for (const file of selected) {
        const upload: StageHomeAttachmentInput = {
          requestKey: crypto.randomUUID(),
          name: file.name,
          mimeType: attachmentMimeTypeSchema.parse(file.type),
          contentHash: hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())),
        };
        next.push({ localId: crypto.randomUUID(), file, upload, state: "local", id: null });
      }
      if (alive.current) setFiles((previous) => [...previous, ...next]);
    },
    [busy],
  );
  const remove = useCallback(
    (localId: string) => {
      if (!busy) setFiles((previous) => previous.filter((file) => file.localId !== localId));
    },
    [busy],
  );

  async function flush(): Promise<boolean> {
    if (busy || !client || !account) return false;
    const pending = latest.current;
    if (!pending.length) return true;
    const controller = new AbortController();
    const mark = (localId: string, change: Partial<ChatFile>) =>
      setFiles((previous) => previous.map((file) => (file.localId === localId ? { ...file, ...change } : file)));
    setError(null);
    setPhase("uploading");
    try {
      const ids: string[] = [];
      for (const file of pending) {
        if (file.id) {
          ids.push(file.id);
          continue;
        }
        mark(file.localId, { state: "uploading" });
        try {
          // The same request key on a retry returns the first upload's receipt, never a second file.
          const receipt = await client.stageHomeAttachment(
            file.upload,
            new Uint8Array(await file.file.arrayBuffer()),
            controller.signal,
          );
          if (!receipt) return false;
          ids.push(receipt.id);
          mark(file.localId, { state: "uploaded", id: receipt.id });
        } catch (cause) {
          mark(file.localId, { state: "error" });
          setError(
            cause instanceof AccountRequestError && [413, 422].includes(cause.status)
              ? `${file.file.name} couldn’t be added: it isn’t a readable image or text file. Remove it and send again.`
              : `${file.file.name} couldn’t be uploaded. Your message is kept; send again to retry.`,
          );
          return false;
        }
      }
      try {
        await boundedAccountRequest(`/api/projects/${projectId}/brief-files`, briefFilesResponseSchema, {
          method: "POST",
          signal: controller.signal,
          body: { attachmentIds: ids },
        });
      } catch (cause) {
        setError(
          cause instanceof AccountRequestError && cause.status === 413
            ? `A brand can hold ${BRIEF_FILE_MAX} files. Remove some and send again.`
            : "The files couldn’t be added to this brand. Your message is kept; send again to retry.",
        );
        return false;
      }
      // The files now belong to the brand, whatever happens to the reading.
      setFiles([]);
      setRevision((value) => value + 1);
      setPhase("reading");
      await read(controller.signal);
      return true;
    } finally {
      if (alive.current) {
        setPhase("idle");
        setRevision((value) => value + 1);
      }
    }
  }

  /** Asks for the reading and waits for it. A reading that fails or runs long never holds the message
   * back: the files stay with the brand and the next Strategy step reads them. */
  async function read(signal: AbortSignal) {
    let runId: string | null = null;
    try {
      const started = await boundedAccountRequest(`/api/projects/${projectId}/generations`, startedSchema, {
        method: "POST",
        signal,
        body: { kind: READ_KIND, idempotencyKey: `brief-files-${crypto.randomUUID()}` },
      });
      runId = started.run.id;
    } catch {
      return; // Unavailable, paused, or a reading is already under way.
    }
    const deadline = Date.now() + READ_WAIT_MS;
    while (alive.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, READ_POLL_MS));
      try {
        const { runs } = await boundedAccountRequest(
          `/api/projects/${projectId}/generations?kind=${READ_KIND}`,
          runsSchema,
          { signal },
        );
        const run = runs.find((item) => item.id === runId);
        if (!run || !["queued", "running"].includes(run.status)) return;
      } catch {
        return;
      }
    }
  }

  return {
    files: files.map((file) => ({
      localId: file.localId,
      name: file.file.name,
      mimeType: file.upload.mimeType,
      byteLength: file.file.size,
      state: file.state,
      ownedRef: null,
    })),
    policy,
    availability,
    busy,
    status: phase === "uploading" ? "Adding your files…" : phase === "reading" ? "Embel is reading your files…" : null,
    error,
    revision,
    reading: phase === "reading",
    add,
    remove,
    flush,
  };
}
