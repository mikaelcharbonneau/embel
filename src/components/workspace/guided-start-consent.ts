import { z } from "zod";
import type { ContextSnapshot, GuidedTurn } from "@/domain/projects";
import type { StrategyAllowance } from "./account-strategy-client";
import { initialGuidedContext } from "./guided-interview-client";

const prefix = "guided-start-v1:";
const receiptSchema = z.strictObject({
  ownerId: z.uuid(),
  projectId: z.uuid().nullable(),
  inputRevision: z.literal(1),
  turnId: z.string().startsWith(prefix).max(128),
  allowance: z.strictObject({ billingMode: z.literal("openai_api"), maximumCostMicrousd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
  attempted: z.boolean(),
});
export type GuidedStartConsent = z.infer<typeof receiptSchema>;
const key = (ownerId: string, turnId: string) => `embel.guided-start-consent.v1:${ownerId}:${turnId}`;

/** Only new Home handoffs use this marker; historical interview turns are unchanged. */
export function isGuidedStartTurn(turn: Pick<GuidedTurn, "id"> | null | undefined) {
  return Boolean(turn?.id.startsWith(prefix));
}

/** A bounded usage receipt, not authentication, project content or job authority. */
export function readGuidedStartConsent(ownerId: string, turnId: string): GuidedStartConsent | null {
  try {
    const raw = window.localStorage.getItem(key(ownerId, turnId));
    if (!raw || raw.length > 2048) return null;
    const parsed = receiptSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.ownerId === ownerId && parsed.data.turnId === turnId ? parsed.data : null;
  } catch { return null; }
}

function write(receipt: GuidedStartConsent) {
  try {
    const valid = receiptSchema.parse(receipt);
    window.localStorage.setItem(key(valid.ownerId, valid.turnId), JSON.stringify(valid));
    return JSON.stringify(readGuidedStartConsent(valid.ownerId, valid.turnId)) === JSON.stringify(valid);
  } catch { return false; }
}

/** Explicit acceptance may replace an unissued allowance, never an attempted request. */
export function rememberGuidedStartConsent(ownerId: string, turnId: string, allowance: StrategyAllowance): boolean {
  if (allowance.billingMode !== "openai_api" || !isGuidedStartTurn({ id: turnId })) return false;
  const previous = readGuidedStartConsent(ownerId, turnId);
  if (previous?.attempted) return previous.allowance.maximumCostMicrousd === allowance.maximumCostMicrousd;
  return write({ ownerId, turnId, projectId: previous?.projectId ?? null, inputRevision: 1, allowance, attempted: false });
}

/** Bind only after an owned exact creation receipt has been acknowledged. */
export function bindGuidedStartConsent(ownerId: string, turnId: string, projectId: string): boolean {
  const receipt = readGuidedStartConsent(ownerId, turnId);
  if (!receipt || (receipt.projectId && receipt.projectId !== projectId)) return false;
  return write({ ...receipt, projectId });
}

/** Persist before POST so a remount cannot blindly retry an unknown admission. */
export function markGuidedStartAttempt(ownerId: string, turnId: string): boolean {
  const receipt = readGuidedStartConsent(ownerId, turnId);
  return Boolean(receipt && write({ ...receipt, attempted: true }));
}

export function guidedStartContext(context: ContextSnapshot, ownerId: string, allowance: StrategyAllowance): ContextSnapshot {
  const next = initialGuidedContext(context, 1);
  const turn = next.intake.guidedInterview?.turns.at(-1);
  if (!turn || next.intake.guidedInterview!.turns.length === (context.intake.guidedInterview?.turns.length ?? 0)) return next;
  turn.id = `${prefix}${turn.id}`;
  // A missing/unwritable receipt never blocks saving. The destination then
  // requires explicit acceptance instead of starting with an inferred allowance.
  rememberGuidedStartConsent(ownerId, turn.id, allowance);
  return next;
}
