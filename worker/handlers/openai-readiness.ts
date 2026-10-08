import type { StrategyJobPolicy, StrategyOperation } from "../../src/domain/strategy-jobs";

type ReadinessDatabase = {
  query(sql: string, values: unknown[]): Promise<{ rows: Array<{ ready?: unknown }> }>;
};

/** A rejected or unreadable database policy stops new claims and provider dispatch. */
export function createStrategyReadiness(database: ReadinessDatabase,
  policies: ReadonlyMap<StrategyOperation, StrategyJobPolicy>, onUnavailable: () => void) {
  const assertPolicyReady = async (operation: StrategyOperation, policy: StrategyJobPolicy): Promise<void> => {
    try {
      const result = await database.query("select public.report_strategy_worker_ready($1, $2, $3) as ready",
        [operation, JSON.stringify(policy), 60]);
      if (result.rows.length !== 1 || result.rows[0]?.ready !== true) throw new Error("Strategy policy unavailable");
    } catch {
      onUnavailable();
      throw new Error("Strategy policy unavailable");
    }
  };
  return {
    assertPolicyReady,
    async reportReadiness(): Promise<void> {
      for (const [operation, policy] of policies) await assertPolicyReady(operation, policy);
    },
  };
}

/** A hosted worker verifies durable operator approval; it cannot create readiness. */
export function createApiTextReadiness(database: ReadinessDatabase, deploymentId: string) {
  return async (operation: StrategyOperation, policy: StrategyJobPolicy): Promise<void> => {
    const result = await database.query("select public.check_api_text_runtime($1, $2, $3) as ready",
      [operation, JSON.stringify(policy), deploymentId]);
    if (result.rows.length !== 1 || result.rows[0]?.ready !== true) throw new Error("Strategy policy unavailable");
  };
}
