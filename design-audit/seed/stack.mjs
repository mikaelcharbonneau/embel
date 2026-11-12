// The audit stack: this checkout's local Supabase (npm run dev:up), the design-audit stand-in AI
// (stand-in-ai.mjs) and the Embel app wired to the local generation engine. Reuses the browser
// journey test's stack definition (tests/journey/stack.mjs) and only changes the AI address
// and the workflow data folder. Loopback only; refuses anything else.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { journeyStack } from "../../tests/journey/stack.mjs";

// The local Supabase runs in Docker (Colima profile "embel"); point the Supabase CLI at it when
// the shell has no Docker address of its own.
const colima = path.join(homedir(), ".colima/embel/docker.sock");
if (!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT && existsSync(colima))
  process.env.DOCKER_HOST = `unix://${colima}`;

export const auditDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const AI_PORT = Number(process.env.AUDIT_AI_PORT ?? "3186");

const LOOPBACK = /^(?:https?|postgres(?:ql)?):\/\/(?:[^@/]+@)?127\.0\.0\.1:\d+(?:\/|$)/u;

export function auditStack() {
  const stack = journeyStack();
  const environment = {
    ...stack.appEnvironment,
    EMBEL_OPENAI_BASE_URL: `http://127.0.0.1:${AI_PORT}`,
    WORKFLOW_LOCAL_DATA_DIR: path.join(auditDir, ".workflow-data"),
  };
  // Safety: every address the app and the seed use must be this machine.
  for (const [name, value] of [
    ["app", stack.appOrigin],
    ["supabase", stack.apiUrl],
    ["database", stack.adminDatabaseUrl],
    ["engine database", environment.EMBEL_ENGINE_DATABASE_URL],
    ["AI", environment.EMBEL_OPENAI_BASE_URL],
    ["public supabase", environment.NEXT_PUBLIC_SUPABASE_URL],
  ])
    if (!LOOPBACK.test(value)) throw new Error(`Refusing to run: the ${name} address is not local (127.0.0.1).`);
  if (!/^sk-journey-fake/u.test(environment.OPENAI_API_KEY))
    throw new Error("Refusing to run: the app must use the stand-in AI key.");
  return { ...stack, aiOrigin: `http://127.0.0.1:${AI_PORT}`, appEnvironment: environment };
}
