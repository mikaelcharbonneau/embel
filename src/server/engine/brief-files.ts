import "server-only";
import { z } from "zod";
import {
  BRIEF_FILE_MAX,
  briefFileNotesSchema,
  briefFileRefSchema,
  type BriefFileNotes,
  type BriefFileRef,
  type BriefFilesInput,
  type BriefFileView,
} from "@/domain/brief-files";
import type { AuthenticatedContext } from "../auth/context";
import { ApiError } from "../http/errors";

// The brand's attached files and their saved reading, read with the person's own login
// (row-level security limits both tables to their owner). Nothing here starts or changes anything.

/** The kind that reads a brand's files outside a Strategy run (files added in the side chat). Free. */
export const BRIEF_FILES_KIND = "brief.read_files";
/** The output key a run saves the reading under (`generation_outputs`). */
export const BRIEF_FILES_OUTPUT_KEY = "files";

/** The verified files linked to this brand, in a stable order. */
async function projectBriefFileRefs(auth: AuthenticatedContext, projectId: string): Promise<BriefFileRef[]> {
  const rows = await auth.client
    .from("home_attachments")
    .select("id,blob_version_id,name,mime_type,content_hash,byte_length")
    .eq("owner_id", auth.userId)
    .eq("project_id", projectId)
    .eq("verified", true)
    .order("id")
    .limit(BRIEF_FILE_MAX);
  if (rows.error) throw new Error("brief_files_unavailable");
  return (rows.data ?? []).flatMap((row) => {
    const ref = briefFileRefSchema.safeParse({
      id: row.id,
      blobVersionId: row.blob_version_id,
      name: row.name,
      mimeType: row.mime_type,
      contentHash: row.content_hash,
      byteLength: Number(row.byte_length),
    });
    // A kind of file the reading step cannot open (none is accepted at upload today) is left out.
    return ref.success ? [ref.data] : [];
  });
}

/** The newest saved reading of this brand's files, from any Strategy run or file-reading run (a run
 * that later failed or was stopped still keeps a reading it finished). Files are only ever added to a
 * brand, so an older reading covers some of today's files: `complete` says whether it covers them all. */
async function savedBriefFileNotes(
  auth: AuthenticatedContext,
  projectId: string,
  refs: readonly BriefFileRef[],
): Promise<{ notes: BriefFileNotes; complete: boolean } | null> {
  const runs = await auth.client
    .from("generation_runs")
    .select("id")
    .eq("owner_id", auth.userId)
    .eq("project_id", projectId)
    .or(`kind.like.strategy.%,kind.eq.${BRIEF_FILES_KIND}`)
    .order("created_at", { ascending: false })
    .limit(50);
  if (runs.error) throw new Error("brief_files_unavailable");
  const ids = z
    .array(z.object({ id: z.uuid() }))
    .parse(runs.data ?? [])
    .map((run) => run.id);
  if (!ids.length) return null;
  const outputs = await auth.client
    .from("generation_outputs")
    .select("output,created_at")
    .eq("owner_id", auth.userId)
    .eq("output_key", BRIEF_FILES_OUTPUT_KEY)
    .in("run_id", ids)
    .order("created_at", { ascending: false })
    .limit(5);
  if (outputs.error) throw new Error("brief_files_unavailable");
  const wanted = new Set(refs.map((ref) => ref.id));
  for (const row of outputs.data ?? []) {
    const notes = briefFileNotesSchema.safeParse(row.output);
    if (notes.success && notes.data.files.every((file) => wanted.has(file.id)))
      return { notes: notes.data, complete: notes.data.files.length === wanted.size };
  }
  return null;
}

/**
 * What a run of this brand is given about its attached files: nothing for a brand without files,
 * otherwise the files and, once one exists, their reading. Files are an addition to the brief: if
 * they cannot be looked up right now the run goes ahead from the written brief, and a later run reads them.
 */
export async function briefFilesForRun(auth: AuthenticatedContext, projectId: string): Promise<BriefFilesInput | null> {
  try {
    const refs = await projectBriefFileRefs(auth, projectId);
    if (!refs.length) return null;
    const saved = await savedBriefFileNotes(auth, projectId, refs);
    // A reading that misses a newer file is not passed on as the reading: the run reads them all again.
    return { refs, notes: saved?.complete ? saved.notes : null };
  } catch {
    return null;
  }
}

/** The brand page's list: each attached file with what was read in it, if it was read yet. */
export async function projectBriefFileViews(auth: AuthenticatedContext, projectId: string): Promise<BriefFileView[]> {
  const refs = await projectBriefFileRefs(auth, projectId);
  if (!refs.length) return [];
  const saved = await savedBriefFileNotes(auth, projectId, refs);
  return refs.map((ref) => {
    const note = saved?.notes.files.find((file) => file.id === ref.id);
    return {
      id: ref.id,
      name: ref.name,
      mimeType: ref.mimeType,
      status: note?.status ?? "waiting",
      kind: note?.status === "read" ? note.kind : null,
      summary: note?.status === "read" ? note.summary : null,
    };
  });
}

/** The reading a prompt outside Strategy is given (naming): whatever was read so far, even when a
 * newer file is still unread. Never a reason to fail the request. */
export async function knownBriefFileNotes(
  auth: AuthenticatedContext,
  projectId: string,
): Promise<BriefFileNotes | null> {
  try {
    const refs = await projectBriefFileRefs(auth, projectId);
    return refs.length ? ((await savedBriefFileNotes(auth, projectId, refs))?.notes ?? null) : null;
  } catch {
    return null;
  }
}

/** Freezes the input of a file-reading run: every file of the brand, to be read afresh. Refused when
 * the brand has no files or they are all read already (nothing to do is not worth a run). */
export async function buildBriefFilesRunInput(
  auth: AuthenticatedContext,
  projectId: string,
): Promise<{ briefFiles: BriefFilesInput }> {
  let refs: BriefFileRef[], saved: Awaited<ReturnType<typeof savedBriefFileNotes>>;
  try {
    refs = await projectBriefFileRefs(auth, projectId);
    saved = refs.length ? await savedBriefFileNotes(auth, projectId, refs) : null;
  } catch {
    throw new ApiError("integration_unavailable");
  }
  if (!refs.length || saved?.complete) throw new ApiError("conflict");
  return { briefFiles: { refs, notes: null } };
}

/** Links files the person already uploaded to one of their own brands (at most five per brand; the
 * database function checks ownership, verification and the limits). Repeating the call is harmless. */
export async function attachFilesToProject(
  auth: AuthenticatedContext,
  projectId: string,
  attachmentIds: readonly string[],
): Promise<void> {
  const { error } = await auth.client.rpc("attach_home_files_to_project", {
    p_input: { projectId, attachmentIds },
  });
  if (!error) return;
  const text = `${error.code ?? ""} ${error.message ?? ""}`;
  if (/home_aggregate_limit/u.test(text)) throw new ApiError("body_too_large");
  if (/not_found|P0002/u.test(text)) throw new ApiError("not_found");
  if (/home_attachment_conflict|PT409/u.test(text)) throw new ApiError("conflict");
  if (/invalid_home_ids|duplicate_home_ids|22023/u.test(text)) throw new ApiError("invalid_input");
  if (/unauthenticated|42501/u.test(text)) throw new ApiError("unauthenticated");
  throw new ApiError("integration_unavailable");
}
