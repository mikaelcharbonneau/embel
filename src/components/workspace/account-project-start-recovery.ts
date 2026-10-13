import { z } from "zod";
import { DRAFT_STORAGE_KEY, getLocalDraft, localDraftStorageState } from "./local-drafts";

// Project creation has no idempotency key. Retain only recovery IDs, never prompts
// or credentials, and do not repeat an unconfirmed create after remount/retry.
const startReceiptSchema = z.strictObject({ ownerId: z.uuid(), draftId: z.uuid(), projectId: z.uuid().nullable() });
export type StartReceipt = z.infer<typeof startReceiptSchema>;
const legacyReceiptKey = "fluid.strategy-starts.v1";
const receiptKey = (ownerId: string) => `fluid.strategy-starts.v2:${ownerId}`;
const receipts = new Map<string, StartReceipt>();
const receiptId = (ownerId: string, draftId: string) => `${ownerId}:${draftId}`;
export class StartReceiptRecoveryError extends Error {}
const ownerReceipts = (ownerId: string) => [...receipts.values()].filter(receipt => receipt.ownerId === ownerId);
function persistReceipts(ownerId: string) {
  try { window.sessionStorage.setItem(receiptKey(ownerId), JSON.stringify(ownerReceipts(ownerId))); }
  catch { /* This running tab retains every unresolved guard when storage fails. */ }
}
function retireConfirmedReceipts(ownerId: string, activeDraftId: string) {
  // A known account destination can retire only when its browser source is gone
  // from both the current draft store and freshly readable durable storage. Never
  // retire an uncertain create or use unavailable/corrupt storage as deletion proof.
  let storedIds: Set<string>;
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (raw && raw.length > 8_000_000) return;
    const stored = z.object({ version: z.literal(1), drafts: z.array(z.object({ id: z.uuid() })).max(50) }).safeParse(JSON.parse(raw ?? '{"version":1,"drafts":[]}'));
    if (!stored.success || localDraftStorageState() !== "available") return;
    storedIds = new Set(stored.data.drafts.map(draft => draft.id));
  } catch { return; }
  let changed = false;
  for (const receipt of ownerReceipts(ownerId)) {
    if (receipt.projectId && receipt.draftId !== activeDraftId && !storedIds.has(receipt.draftId) && !getLocalDraft(receipt.draftId)) {
      receipts.delete(receiptId(ownerId, receipt.draftId)); changed = true;
    }
  }
  if (changed) persistReceipts(ownerId);
}
export function readReceipt(ownerId: string, draftId: string) {
  let raw: string | null = null, legacy = false;
  try {
    raw = window.sessionStorage.getItem(receiptKey(ownerId));
    if (raw === null) { raw = window.sessionStorage.getItem(legacyReceiptKey); legacy = true; }
  } catch { /* Existing in-memory guards remain authoritative in this tab. */ }
  if (raw !== null) {
    const stored = z.array(startReceiptSchema).max(legacy ? 200 : 250).safeParse((() => { try { return JSON.parse(raw); } catch { return null; } })());
    if (!stored.success || (!legacy && stored.data.some(receipt => receipt.ownerId !== ownerId))) throw new StartReceiptRecoveryError("Saved recovery records could not be verified. No new account project or AI request was sent. Check account brands before continuing.");
    for (const receipt of stored.data) if (receipt.ownerId === ownerId && !receipts.has(receiptId(ownerId, receipt.draftId))) receipts.set(receiptId(ownerId, receipt.draftId), receipt);
  }
  retireConfirmedReceipts(ownerId, draftId);
  return receipts.get(receiptId(ownerId, draftId)) ?? null;
}
export function readDraftFence(draftId: string) {
  if ([...receipts.values()].some(receipt => receipt.draftId === draftId)) return true;
  // Older Home markers had no edit-fence bit. Before authentication, consult only
  // the local receipt metadata for a boolean fence; never expose an owner's destination.
  for (let index = 0; index < window.sessionStorage.length; index++) {
    const key = window.sessionStorage.key(index);
    if (!key || (key !== legacyReceiptKey && !key.startsWith("fluid.strategy-starts.v2:"))) continue;
    const raw = window.sessionStorage.getItem(key);
    if (!raw?.includes(draftId)) continue;
    const stored = z.array(startReceiptSchema).max(250).safeParse((() => { try { return JSON.parse(raw); } catch { return null; } })());
    if (!stored.success) throw new StartReceiptRecoveryError("Saved recovery records could not be verified. Check account brands before continuing.");
    if (stored.data.some(receipt => receipt.draftId === draftId)) return true;
  }
  return false;
}
export function rememberReceipt(receipt: StartReceipt) {
  const owned = ownerReceipts(receipt.ownerId);
  if (!receipts.has(receiptId(receipt.ownerId, receipt.draftId)) && (owned.filter(item => item.projectId === null).length >= 200 || owned.length >= 250)) {
    throw new StartReceiptRecoveryError("Recovery storage is full for this account. No new account project or AI request was sent. Check the existing account saves before continuing; their recovery links remain available.");
  }
  receipts.set(receiptId(receipt.ownerId, receipt.draftId), receipt);
  persistReceipts(receipt.ownerId);
}
export function forgetReceipt(receipt: StartReceipt) {
  receipts.delete(receiptId(receipt.ownerId, receipt.draftId));
  persistReceipts(receipt.ownerId);
}
export function hasDraftReceipt(draftId: string) {
  return [...receipts.values()].some(receipt => receipt.draftId === draftId);
}
