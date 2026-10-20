export type WorkerBuildProvenance = Readonly<{ version: 1; sourceRevision: string | null;
  sourceFingerprint: string; dependencyFingerprint: string; fingerprint: string }>;
// Replaced only by the isolated artifact builder. A normal source import is
// explicitly unqualified, never inferred from runtime environment variables.
declare const __EMBEL_API_TEXT_BUILD__: WorkerBuildProvenance | undefined;
export function workerBuildProvenance(): WorkerBuildProvenance | null {
  return typeof __EMBEL_API_TEXT_BUILD__ === "undefined" ? null : __EMBEL_API_TEXT_BUILD__ ?? null;
}
/** Called only after the existing protected readiness handler succeeds. */
export function addWorkerBuildProvenance(response: Response): Response {
  const provenance = workerBuildProvenance();
  if (response.status === 200 && provenance) {
    response.headers.set("x-embel-worker-fingerprint", provenance.fingerprint);
    if (provenance.sourceRevision) response.headers.set("x-embel-worker-source-revision", provenance.sourceRevision);
  }
  return response;
}
