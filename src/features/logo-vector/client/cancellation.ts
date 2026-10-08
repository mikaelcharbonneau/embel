import { AccountRequestError } from "../../../components/workspace/account-api";
import { isAccountLogoClientCurrent } from "../../../components/identity/account-logo-client";
import { recoverVectorMutation, type LogoVectorMutationContext } from "./recovery";
import { logoVectorEditCommandSchema, logoVectorEditRequestStateSchema, sameLogoVectorEditCommand, type LogoVectorEditCommand, type LogoVectorEditRequestState } from "../model/cancellation";

function current(input: LogoVectorMutationContext): boolean {
  return input.isCurrent() && !input.signal?.aborted && isAccountLogoClientCurrent(input.client, input.account, input.projectId);
}
function retained(input: LogoVectorMutationContext): LogoVectorEditCommand | null {
  if (!current(input)) return null;
  const draft = input.memory.get(input.projectId), raw = draft?.pendingMutation?.command;
  if (!draft?.workspace || raw?.method !== "saveLogoEdit") return null;
  const parsed = logoVectorEditCommandSchema.safeParse(raw);
  if (!parsed.success || draft.pendingMutation?.requestKey !== parsed.data.body.requestKey) throw new AccountRequestError(422);
  return parsed.data;
}
async function settle(input: LogoVectorMutationContext, command: LogoVectorEditCommand, raw: unknown): Promise<LogoVectorEditRequestState | null> {
  if (!current(input) || !sameLogoVectorEditCommand(input.memory.get(input.projectId)?.pendingMutation?.command, command)) return null;
  const parsed = logoVectorEditRequestStateSchema.safeParse(raw);
  if (!parsed.success) throw new AccountRequestError(502);
  const state = parsed.data;
  if (state.status === "not_found") return null;
  if (state.ownerId !== input.account.userId || state.projectId !== input.projectId || state.requestKey !== command.body.requestKey || !sameLogoVectorEditCommand(state.command, command)) throw new AccountRequestError(502);
  if (state.status === "succeeded") {
    // An edit that won the project lock is still a normal successful mutation.
    // Existing recovery verifies it and refreshes current heads without replaying.
    return await recoverVectorMutation(input, false) ? state : null;
  }
  const latest = input.memory.get(input.projectId);
  if (!latest || !current(input) || !sameLogoVectorEditCommand(latest.pendingMutation?.command, command)) return null;
  // Release only the exact fenced mutation. Keep vectorDraft, newer edits, all
  // unrelated pending work, heads and conflict state exactly as they are.
  input.memory.set(input.projectId, { ...latest, pendingMutation: null });
  return state;
}
/** User-triggered action only. POST the full original retained command unchanged. */
export async function cancelVectorMutation(input: LogoVectorMutationContext): Promise<LogoVectorEditRequestState | null> {
  const command = retained(input); if (!command) return null;
  const state = await input.client.cancelLogoVectorEdit(command, input.signal);
  if (!state) return null;
  // Defensive even for alternate clients: a successful POST must carry proof.
  if (state.status === "not_found") throw new AccountRequestError(502);
  return settle(input, command, state);
}
/** Recover a lost cancellation acknowledgement by read only. Absence never
 * releases the pending edit and never causes a cancellation POST or edit retry. */
export async function recoverVectorCancellation(input: LogoVectorMutationContext): Promise<LogoVectorEditRequestState | null> {
  const command = retained(input); if (!command) return null;
  const state = await input.client.readLogoVectorEditRequest(command.body.requestKey, input.signal);
  return state ? settle(input, command, state) : null;
}
