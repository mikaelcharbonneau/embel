import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentSession, AgentSessionItem } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns/turns";
import type { ManagedHistoryPage, NamingManagedProtocol } from "./protocol";

export class ManagedEvidenceError extends Error {
  constructor(readonly code: "identity_mismatch" | "history_limit" | "history_conflict" | "turn_not_completed" | "final_output_invalid" | "output_limit") { super(code); }
}
export type ManagedTurnHistory = { session: AgentSession; turn: Turn | null; items: AgentSessionItem[] };
export type ManagedFinalOutput = { itemId: string; itemContentHash: string; text: string; value: unknown };
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 300;
const turnStatuses = new Set(["queued", "in_progress", "waiting", "completed", "failed", "cancelled"]);

async function collectPages<T extends { id: string | null }>(read: (after: string | null) => Promise<ManagedHistoryPage<T>>, maximum: number): Promise<T[]> {
  let after: string | null = null;
  const cursors = new Set<string>();
  const records: T[] = [];
  let bytes = 0;
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await read(after);
    if (!Array.isArray(page.data) || typeof page.hasMore !== "boolean") throw new ManagedEvidenceError("history_conflict");
    for (const row of page.data) {
      if (row?.id !== null && !id(row?.id)) throw new ManagedEvidenceError("identity_mismatch");
      bytes += Buffer.byteLength(JSON.stringify(row), "utf8");
      if (records.length >= maximum || bytes > 1_048_576) throw new ManagedEvidenceError("history_limit");
      records.push(row);
    }
    if (!page.hasMore) return records;
    if (!id(page.after) || !page.data.length || cursors.has(page.after)) throw new ManagedEvidenceError("history_limit");
    after = page.after; cursors.add(after);
  }
  throw new ManagedEvidenceError("history_limit");
}

/** Read only. The caller subscribes/buffers before calling this; history never resubmits input. */
export async function readManagedTurnHistory(protocol: NamingManagedProtocol, sessionId: string, intendedTurnId: string | null, signal: AbortSignal): Promise<ManagedTurnHistory> {
  const session = await protocol.retrieveSession(sessionId, signal);
  if (session.id !== sessionId || !id(session.agent?.id)) throw new ManagedEvidenceError("identity_mismatch");
  let turn: Turn | null;
  if (intendedTurnId !== null) turn = await protocol.retrieveTurn(sessionId, intendedTurnId, signal);
  else {
    const turns = await collectPages(after => protocol.listTurns(sessionId, after, signal), 10);
    if (turns.length > 1) throw new ManagedEvidenceError("identity_mismatch");
    turn = turns[0] ?? null;
  }
  if (!turn) return { session, turn: null, items: [] };
  if (!id(turn.id) || intendedTurnId !== null && turn.id !== intendedTurnId || turn.session_id !== sessionId || turn.subagent_id !== null || turn.agent_id !== session.agent.id || !turnStatuses.has(turn.status)) throw new ManagedEvidenceError("identity_mismatch");
  const rows = await collectPages(after => protocol.listItems(sessionId, turn.id, after, signal), 500);
  const items = new Map<string, AgentSessionItem>();
  for (const item of rows) {
    if (!("turn_id" in item) || item.turn_id !== turn.id) throw new ManagedEvidenceError("identity_mismatch");
    if (item.type === "message" && item.role === "user" && item.id === null) continue;
    if (!id(item.id)) throw new ManagedEvidenceError("identity_mismatch");
    const previous = items.get(item.id);
    if (previous && !isDeepStrictEqual(previous, item) && !("status" in previous && previous.status === "in_progress" && "status" in item && item.status !== "in_progress" && previous.type === item.type)) throw new ManagedEvidenceError("history_conflict");
    items.set(item.id, item);
  }
  return { session, turn, items: [...items.values()] };
}

/** Matches the SDK's non-commentary final-message rule; root turn completion is independently required. */
export function extractManagedFinalOutput(history: ManagedTurnHistory, maximumBytes = 524_288): ManagedFinalOutput {
  if (history.turn?.status !== "completed") throw new ManagedEvidenceError("turn_not_completed");
  const messages = history.items.filter(item => item.type === "message" && item.role === "assistant" && item.status === "completed" && item.phase !== "commentary");
  if (messages.length !== 1) throw new ManagedEvidenceError("final_output_invalid");
  const message = messages[0]!;
  if (message.type !== "message" || !id(message.id) || !Array.isArray(message.content) || !message.content.length || message.content.some(part => part.type !== "output_text" || typeof part.text !== "string")) throw new ManagedEvidenceError("final_output_invalid");
  const text = message.content.map(part => "text" in part ? part.text : "").join("");
  if (Buffer.byteLength(text, "utf8") > maximumBytes) throw new ManagedEvidenceError("output_limit");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ManagedEvidenceError("final_output_invalid"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ManagedEvidenceError("final_output_invalid");
  return { itemId: message.id, itemContentHash: createHash("sha256").update(text).digest("hex"), text, value };
}
