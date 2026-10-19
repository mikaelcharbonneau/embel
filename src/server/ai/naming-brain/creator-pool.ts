import "server-only";

export type NamingCreatorTask<T> = { assignmentKey: string; sessionLimitCents: number; execute(signal: AbortSignal): Promise<T> };
export type NamingCreatorPoolResult<T> = {
  results: { assignmentKey: string; value: T }[];
  failures: { assignmentKey: string; code: "creator_execution_unknown" }[];
  notStarted: string[];
  stopped: boolean;
};

/** Schedule an already-persisted immutable call plan with at most three calls at once. */
export async function runNamingCreatorPool<T>(inputTasks: readonly NamingCreatorTask<T>[], options: {
  maximumTotalCents: number; localUnlimited?: boolean; signal: AbortSignal; stopAfter(value: T): boolean;
}): Promise<NamingCreatorPoolResult<T>> {
  const tasks = inputTasks.map(task => Object.freeze({ ...task }));
  if ((!options.localUnlimited && (!Number.isSafeInteger(options.maximumTotalCents) || options.maximumTotalCents < 1 || options.maximumTotalCents > 150)) || tasks.length > 30 ||
      new Set(tasks.map(task => task.assignmentKey)).size !== tasks.length || tasks.some(task => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(task.assignmentKey) || !Number.isSafeInteger(task.sessionLimitCents) || task.sessionLimitCents < 1) ||
      (!options.localUnlimited && tasks.reduce((sum, task) => sum + task.sessionLimitCents, 0) > options.maximumTotalCents)) throw new Error("invalid_creator_plan");
  const controller = new AbortController();
  let stopped = options.signal.aborted, next = 0;
  const started = new Set<number>();
  const results = new Map<number, T>();
  const failures = new Set<number>();
  const stop = () => { stopped = true; controller.abort(); };
  // A local sibling failure closes the queue, while already-issued work keeps
  // its own finite deadline. Explicit cancellation still aborts every slot.
  const stopScheduling = () => { stopped = true; if (!options.localUnlimited) controller.abort(); };
  options.signal.addEventListener("abort", stop, { once: true });
  if (stopped) controller.abort();
  const slot = async () => {
    while (!stopped && !controller.signal.aborted) {
      const index = next++;
      const task = tasks[index];
      if (!task) return;
      started.add(index);
      try {
        const value = await task.execute(controller.signal);
        results.set(index, value);
        if (options.stopAfter(value)) stopScheduling();
      } catch { failures.add(index); stopScheduling(); }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, slot)); }
  finally { options.signal.removeEventListener("abort", stop); }
  return {
    results: tasks.flatMap((task, index) => results.has(index) ? [{ assignmentKey: task.assignmentKey, value: results.get(index)! }] : []),
    failures: tasks.flatMap((task, index) => failures.has(index) ? [{ assignmentKey: task.assignmentKey, code: "creator_execution_unknown" as const }] : []),
    notStarted: tasks.filter((_task, index) => !started.has(index)).map(task => task.assignmentKey), stopped,
  };
}
