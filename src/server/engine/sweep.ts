import "server-only";
import { z } from "zod";
import { engineCall } from "./database";

/** How many overdue runs one scheduled call may end. The oldest go first; the next call takes the rest. */
export const OVERDUE_SWEEP_LIMIT = 200;

const sweepResultSchema = z.object({ ended: z.number().int().nonnegative(), failed: z.number().int().nonnegative() });
export type OverdueSweepResult = z.infer<typeof sweepResultSchema>;

/**
 * Ends every owner's overdue runs and returns their credits (fluid_private.engine_expire_overdue_runs,
 * migration 20261114150000): queued with no workflow for 10 minutes, or running past the kind's time
 * limit. It never starts work and ignores the pause switch: ending and refunding are safe while paused.
 * `failed` counts overdue runs whose ending raised an error in the database; they stay as they were.
 */
export async function expireOverdueRuns(): Promise<OverdueSweepResult> {
  return sweepResultSchema.parse(await engineCall("engine_expire_overdue_runs", [OVERDUE_SWEEP_LIMIT]));
}
