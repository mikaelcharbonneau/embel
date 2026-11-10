import { createCoreReadinessReader } from "@/server/runtime/application-health";
export const dynamic = "force-dynamic";
const read = createCoreReadinessReader();
export async function GET() {
  const result = await read();
  return Response.json(result, {
    status: result.status === "ready" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
