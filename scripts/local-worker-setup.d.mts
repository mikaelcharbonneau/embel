import type { ReadStream, WriteStream } from "node:tty";

export function validateWorkerSetupInvocation(args: string[], environment: Record<string, string | undefined>): void;
export function writeLocalWorkerEnvironment(root: string, password: string, options?: { signal?: AbortSignal }): Promise<void>;
export function readHiddenWorkerPassword(input: ReadStream, output: WriteStream, prompt: string, options?: { signal?: AbortSignal }): Promise<string>;
