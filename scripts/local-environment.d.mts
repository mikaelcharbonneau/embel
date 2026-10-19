import type { PoolConfig } from "pg";

export function localWorkerDatabaseConfiguration(value: string): PoolConfig;
export function localPrototypeDatabaseConfiguration(value: string): PoolConfig;
export function prepareLocalChildEnvironments(
  root: string,
  inherited: Record<string, string | undefined>,
  options: { bridgeToken: string; connectionApproved?: boolean; prototype?: boolean },
): Promise<{ web: NodeJS.ProcessEnv; worker: NodeJS.ProcessEnv }>;
