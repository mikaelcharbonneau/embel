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

// The brand's attached files and their saved reading, read with the person's own login
// (row-level security limits both tables to their owner). Nothing here starts or changes anything.

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

/** The newest saved reading that covers exactly these files, from any Strategy run of the brand
 * (a run that later failed or was stopped still keeps a reading it finished). */
async function savedBriefFileNotes(
  auth: AuthenticatedContext,
  projectId: string,
  refs: readonly BriefFileRef[],
): Promise<BriefFileNotes | null> {
  const runs = await auth.client
    .from("generation_runs")
    .select("id")
    .eq("owner_id", auth.userId)
    .eq("project_id", projectId)
    .like("kind", "strategy.%")
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
  const wanted = refs.map((ref) => ref.id).sort();
  for (const row of outputs.data ?? []) {
    const notes = briefFileNotesSchema.safeParse(row.output);
    if (notes.success && JSON.stringify(notes.data.files.map((file) => file.id).sort()) === JSON.stringify(wanted))
      return notes.data;
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
    return { refs, notes: await savedBriefFileNotes(auth, projectId, refs) };
  } catch {
    return null;
  }
}

/** The brand page's list: each attached file with what was read in it, if it was read yet. */
export async function projectBriefFileViews(auth: AuthenticatedContext, projectId: string): Promise<BriefFileView[]> {
  const refs = await projectBriefFileRefs(auth, projectId);
  if (!refs.length) return [];
  const notes = await savedBriefFileNotes(auth, projectId, refs);
  return refs.map((ref) => {
    const note = notes?.files.find((file) => file.id === ref.id);
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
