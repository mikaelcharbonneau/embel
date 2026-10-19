export type LocalPrototypeChild = {
  readonly pid?: number;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  kill(signal: NodeJS.Signals): unknown;
};
export type LocalSupervisorEvent = { at: string } & (
  | { event: "local_child_exit"; role: "worker" | "web"; code: number | null; signal: string | null; cause: "exit" | "spawn_error" }
  | { event: "local_child_error"; role: "worker" | "web" }
  | { event: "local_worker_restart"; attempt: number; delayMs: number }
  | { event: "local_worker_unavailable"; attempts: number }
  | { event: "local_shutdown"; signal: "SIGTERM" | "SIGINT" }
  | { event: "local_shutdown_forced" }
);
export function superviseLocalPrototype(options: {
  startWorker(): LocalPrototypeChild;
  startWeb(): LocalPrototypeChild;
  onEvent(event: LocalSupervisorEvent): void;
  onExitCode(code: number): void;
}): { stop(code?: number, signal?: "SIGTERM" | "SIGINT"): void };
