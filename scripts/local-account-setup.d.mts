import type { request as httpsRequest } from "node:https";
import type { ReadStream, WriteStream } from "node:tty";

export function validateAccountSetupInvocation(args: string[], environment: Record<string, string | undefined>, execArgs?: string[]): void;
export function readAccountPublicConfiguration(root: string): Promise<{ publishableKey: string }>;
export function parseSignupConfirmationLink(value: string): { token_hash: string; type: "signup" };
export function requestAccountSetup(action: string, key: string, body: unknown, options?: { signal?: AbortSignal; request?: typeof httpsRequest }): Promise<unknown>;
export function readHiddenConfirmationLink(input: ReadStream, output: WriteStream, options?: { signal?: AbortSignal }): Promise<string>;
export function runLocalAccountSetup(options: {
  root: string; input: ReadStream; output: WriteStream; environment: Record<string, string | undefined>;
  args?: string[]; execArgs?: string[]; signal?: AbortSignal; post?: typeof requestAccountSetup;
}): Promise<{ ownerId: string }>;
