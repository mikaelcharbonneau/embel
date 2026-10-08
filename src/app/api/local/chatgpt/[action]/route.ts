import { proxyLocalChatGPT } from "@/server/local-chatgpt/bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ action: string }> };
export async function GET(request: Request, context: Context) { return proxyLocalChatGPT(request, (await context.params).action); }
export async function POST(request: Request, context: Context) { return proxyLocalChatGPT(request, (await context.params).action); }
