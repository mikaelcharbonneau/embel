export function GET() {
  return Response.json({ service: "fluid-web", status: "ok", release: "foundation" }, { headers: { "Cache-Control": "no-store" } });
}
