import type { spawn as spawnProcess, SpawnOptions } from "node:child_process";
import type { ReadStream, WriteStream } from "node:tty";

export function validateWorkerPasswordInvocation(args: string[], environment: Record<string, string | undefined>, execArgs?: string[]): void;
export function prepareWorkerPasswordCommand(root: string): Promise<{ executable: string; args: string[]; options: SpawnOptions }>;
export function runWorkerPasswordSetup(options: {
  root: string; input: ReadStream; output: WriteStream; errorOutput: WriteStream; environment: Record<string, string | undefined>;
  args?: string[]; execArgs?: string[]; spawn?: typeof spawnProcess;
}): Promise<number>;
