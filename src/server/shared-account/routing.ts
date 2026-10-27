import "server-only";

/** Selects versioned RPCs, not execution authority. Auth, fixed-slot identity,
 * target policy and immutable admission are independently checked by SQL. */
export function isSharedWorkerRuntime(env: Readonly<Record<string,string|undefined>> = process.env): boolean {
 return env.EMBEL_SHARED_WORKERS_ENABLED === "true";
}
