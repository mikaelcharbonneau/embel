"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { boundedAccountRequest } from "@/components/workspace/bounded-account-request";
import { BRIEF_FILE_KIND_LABELS, briefFilesResponseSchema, type BriefFileView } from "@/domain/brief-files";

/** While Embel works and a file is still unread, look again this often. */
const RECHECK_MS = 4_000;

/** The files attached to a brand's first prompt, under that prompt in the conversation, each with what
 * Embel read in it. They are read when research starts; until then the list says so. Nothing is shown
 * for a brand without files, or when the list cannot be loaded (the brand works without it). */
export function BriefFiles({ projectId, working }: { projectId: string; working: boolean }) {
  const [loaded, setLoaded] = useState<{ projectId: string; files: BriefFileView[] } | null>(null);
  const files = loaded?.projectId === projectId ? loaded.files : null;
  const unread = files === null || files.some((file) => file.status === "waiting");
  useEffect(() => {
    // Read once, again whenever Embel starts or finishes working, and while it works on unread files.
    if (!unread) return;
    const controller = new AbortController();
    const read = () =>
      void boundedAccountRequest(`/api/projects/${projectId}/brief-files`, briefFilesResponseSchema, {
        signal: controller.signal,
      })
        .then((result) => {
          if (!controller.signal.aborted) setLoaded({ projectId, files: result.files });
        })
        .catch(() => undefined);
    read();
    const timer = working ? setInterval(read, RECHECK_MS) : null;
    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [projectId, working, unread]);
  if (!files?.length) return null;
  return (
    <ul className="brief-files" aria-label="Attached files">
      {files.map((file) => (
        <li key={file.id} data-status={file.status}>
          <Icon name={file.mimeType.startsWith("image/") ? "image" : "file-text"} size="sm" />
          <div>
            <p className="brief-file-name">
              {file.name}
              {file.status === "read" && file.kind && (
                <span className="brief-file-kind">{BRIEF_FILE_KIND_LABELS[file.kind]}</span>
              )}
            </p>
            <p className="brief-file-note">
              {file.status === "read"
                ? file.summary
                : file.status === "unreadable"
                  ? "Embel couldn’t read this file, so it isn’t used."
                  : working
                    ? "Reading…"
                    : "Embel reads this when research starts."}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
