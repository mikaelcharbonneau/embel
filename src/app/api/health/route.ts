import { applicationRevision } from "@/server/runtime/application-health";
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json({ service: "fluid-web", status: "ok", release: applicationRevision(), readiness: "not_checked" }, { headers: { "Cache-Control": "no-store" } });
}
