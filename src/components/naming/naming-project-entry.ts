import { AccountRequestError } from "@/components/workspace/account-api";
import { boundedAccountRequest } from "@/components/workspace/bounded-account-request";
import { accountProjectResponseSchema } from "@/domain/project-api";
import { contextSnapshotSchema, createProjectInputSchema } from "@/domain/projects";
import type { NamingAccount, NamingBrainMemory } from "./naming-brain-memory";

/** An explicit brief submission saves one project. It does not dispatch generation. */
export async function startNamingProject({ memory, account, request = boundedAccountRequest, expire }: { memory: NamingBrainMemory; account: NamingAccount; request?: typeof boundedAccountRequest; expire?: (account: NamingAccount) => void }): Promise<string | null> {
  const before = memory.getEntry(account);
  if (!before || memory.getRecovery(account)) return null;
  if (before.projectId) return before.projectId;
  const operation = "naming-project-entry", controller = memory.acquire(account, operation);
  if (!controller) return null;
  try {
    const input = before.input ?? createProjectInputSchema.parse({ title: Array.from(before.description.trim()).slice(0, 80).join(""), scope: "naming_only", requestKey: crypto.randomUUID(),
      context: contextSnapshotSchema.parse({ description: before.description, creativeLocale: before.language, intake: { namingNotes: before.direction } }) });
    memory.setEntry(account, value => ({ ...value, input, busy: true, error: null }));
    const reply = accountProjectResponseSchema.parse(await request("/api/projects", accountProjectResponseSchema, { method: "POST", body: input, expectedOwnerId: account.userId, signal: controller.signal }));
    if (!memory.operationCurrent(account, operation, controller)) return null;
    const project = reply.project;
    // An exact creation replay may return the later owned head, including explicit scope expansion.
    if (project.owner_id !== account.userId || project.scope === "visual_identity_only" || project.current_revision === 1 && (project.scope !== "naming_only" || project.title !== input.title || JSON.stringify(project.context) !== JSON.stringify(input.context))) throw new AccountRequestError(502);
    memory.setEntry(account, value => ({ ...value, projectId: project.id, input: null, error: null })); return project.id;
  } catch (error) {
    if (!memory.operationCurrent(account, operation, controller)) return null;
    const validation = !(error instanceof AccountRequestError) && !memory.getEntry(account)?.input;
    const rejected = error instanceof AccountRequestError && [400, 401, 403, 413, 422, 429].includes(error.status);
    memory.setEntry(account, value => ({ ...value, ...(rejected ? { input: null } : {}), error: validation ? "Add a brief and a language of 2–30 characters before continuing." : rejected ? "This brief was not saved. Review the fields and your account, then try again. Your edits are kept." : "This project save could not be confirmed. Your brief is kept. Continue to retry this same project." }));
    if (error instanceof AccountRequestError && error.status === 401) expire?.(account);
    return null;
  } finally { if (memory.operationCurrent(account, operation, controller)) memory.setEntry(account, value => ({ ...value, busy: false })); memory.release(operation, controller); }
}
