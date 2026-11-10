import { z } from "zod";
import { createProjectInputSchema } from "@/domain/projects";
import {
  DRAFT_STORAGE_KEY,
  getLocalDraft,
  localDraftStorageState,
  readDurableLocalDraft,
  updateLocalDraft,
} from "./local-drafts";

// Retain the exact original creation payload and key. Older receipts have no
// replay contract and must remain fenced rather than being issued a new key.
const startReceiptSchema = z
  .strictObject({
    ownerId: z.uuid(),
    draftId: z.uuid(),
    projectId: z.uuid().nullable(),
    request: z.strictObject({ key: z.uuid(), input: createProjectInputSchema }).optional(),
    attachedRequestKey: z.uuid().optional(),
  })
  .refine((receipt) => !(receipt.request && receipt.attachedRequestKey));
export type StartReceipt = z.infer<typeof startReceiptSchema>;
// Records written by an older app version can stop matching today's request format, e.g. a
// project type that was retired. Each record is checked on its own. One that still names its
// owner and source keeps fencing that source, but without its outdated request, so it can never
// be replayed. One that can't be tied to a source fences nothing and is ignored, so a single
// old record no longer blocks every new project. Storage that isn't a list at all stays an error.
const fenceOnlySchema = z.object({ ownerId: z.uuid(), draftId: z.uuid(), projectId: z.uuid().nullable() });
const MAX_STORED_RECEIPTS = 1_000;
function readStoredReceipt(value: unknown): StartReceipt | null {
  const current = startReceiptSchema.safeParse(value);
  if (current.success) return current.data;
  const fence = fenceOnlySchema.safeParse(value);
  return fence.success
    ? { ownerId: fence.data.ownerId, draftId: fence.data.draftId, projectId: fence.data.projectId }
    : null;
}
/** The usable records in a stored list; null when the value isn't a readable list. Records of
 * another owner are skipped when `ownerId` is given. */
function readStoredReceipts(raw: string, ownerId: string | null): StartReceipt[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_STORED_RECEIPTS) return null;
  return parsed.flatMap((value) => {
    const receipt = readStoredReceipt(value);
    return receipt && (ownerId === null || receipt.ownerId === ownerId) ? [receipt] : [];
  });
}
const legacyReceiptKey = "fluid.strategy-starts.v1";
const receiptKey = (ownerId: string) => `fluid.strategy-starts.v2:${ownerId}`;
const durableReceiptKey = (ownerId: string) => `fluid.project-starts.v3:${ownerId}`;
const attachedReceiptKey = (ownerId: string, draftId: string) => `fluid.attached-starts.v1:${ownerId}:${draftId}`;
const sourceReceiptKey = (ownerId: string, draftId: string) => `fluid.project-source.v1:${ownerId}:${draftId}`;
const receipts = new Map<string, StartReceipt>();
const receiptId = (ownerId: string, draftId: string) => `${ownerId}:${draftId}`;
export class StartReceiptRecoveryError extends Error {}
/** Coordinate the two project creation endpoints across tabs for one source. */
export function withProjectStartLock<T>(
  ownerId: string,
  draftId: string,
  signal: AbortSignal,
  action: () => Promise<T>,
  requireLock = false,
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks)
    return navigator.locks.request(`fluid.project-start:${ownerId}:${draftId}`, { signal }, action);
  if (requireLock)
    return Promise.reject(
      new StartReceiptRecoveryError(
        "Attached saving could not be coordinated in this browser. Your prompt and files are retained; try again in a supported browser.",
      ),
    );
  // Plain project saves have an authoritative owner/source key in the database.
  return action();
}
const ownerReceipts = (ownerId: string) => [...receipts.values()].filter((receipt) => receipt.ownerId === ownerId);
function persistReceipts(ownerId: string) {
  const serialized = JSON.stringify(ownerReceipts(ownerId));
  try {
    window.sessionStorage.setItem(receiptKey(ownerId), JSON.stringify(ownerReceipts(ownerId)));
  } catch {
    /* This running tab retains every unresolved guard when storage fails. */
  }
  try {
    window.localStorage.setItem(durableReceiptKey(ownerId), serialized);
  } catch {
    /* A tab-only receipt remains protected until its owner can recover it. */
  }
}
function retireConfirmedReceipts(ownerId: string, activeDraftId: string) {
  // A known account destination can retire only when its browser source is gone
  // from both the current draft store and freshly readable durable storage. Never
  // retire an uncertain create or use unavailable/corrupt storage as deletion proof.
  let storedIds: Set<string>;
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (raw && raw.length > 8_000_000) return;
    const stored = z
      .object({ version: z.literal(1), drafts: z.array(z.object({ id: z.uuid() })).max(50) })
      .safeParse(JSON.parse(raw ?? '{"version":1,"drafts":[]}'));
    if (!stored.success || localDraftStorageState() !== "available") return;
    storedIds = new Set(stored.data.drafts.map((draft) => draft.id));
  } catch {
    return;
  }
  let changed = false;
  for (const receipt of ownerReceipts(ownerId)) {
    if (
      receipt.projectId &&
      receipt.draftId !== activeDraftId &&
      !storedIds.has(receipt.draftId) &&
      !getLocalDraft(receipt.draftId)
    ) {
      receipts.delete(receiptId(ownerId, receipt.draftId));
      changed = true;
    }
  }
  if (changed) persistReceipts(ownerId);
}
export function readReceipt(ownerId: string, draftId: string) {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(receiptKey(ownerId));
    if (raw === null) raw = window.sessionStorage.getItem(legacyReceiptKey);
  } catch {
    /* Existing in-memory guards remain authoritative in this tab. */
  }
  if (raw !== null) {
    const stored = readStoredReceipts(raw, ownerId);
    if (!stored)
      throw new StartReceiptRecoveryError(
        "Saved recovery records could not be verified. No new account project or AI request was sent. Check account brands before continuing.",
      );
    for (const receipt of stored)
      if (!receipts.has(receiptId(ownerId, receipt.draftId)))
        receipts.set(receiptId(ownerId, receipt.draftId), receipt);
  }
  let durable: string | null = null;
  try {
    durable = window.localStorage.getItem(durableReceiptKey(ownerId));
  } catch {
    /* Retain this tab's verified records. */
  }
  if (durable !== null) {
    const stored = readStoredReceipts(durable, ownerId);
    if (!stored)
      throw new StartReceiptRecoveryError(
        "Saved recovery records could not be verified. Check your projects before continuing.",
      );
    for (const receipt of stored) {
      const prior = receipts.get(receiptId(ownerId, receipt.draftId));
      if (!prior || (!prior.projectId && receipt.projectId)) receipts.set(receiptId(ownerId, receipt.draftId), receipt);
    }
  }
  for (const key of [attachedReceiptKey(ownerId, draftId), sourceReceiptKey(ownerId, draftId)]) {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      /* New admission must establish a durable source guard below. */
    }
    if (raw === null) continue;
    // This key names its owner and source, so even an unreadable record keeps fencing them.
    const parsed = readStoredReceipt(
      (() => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })(),
    );
    if (parsed && (parsed.ownerId !== ownerId || parsed.draftId !== draftId))
      throw new StartReceiptRecoveryError(
        "This project's recovery record could not be verified. No new project was created.",
      );
    const stored = parsed ?? { ownerId, draftId, projectId: null };
    const prior = receipts.get(receiptId(ownerId, draftId));
    if ((prior?.request && stored.attachedRequestKey) || (prior?.attachedRequestKey && stored.request))
      throw new StartReceiptRecoveryError(
        "This project has conflicting save records. Check your saved projects before continuing.",
      );
    // The source's own record is authoritative, unless it was unreadable and another one exists.
    if (parsed ? !prior?.projectId || stored.projectId : !prior) receipts.set(receiptId(ownerId, draftId), stored);
  }
  // A newly admitted tab-only source can be flushed by a later draft-store
  // write. Its immutable endpoint marker travels with it even if quota prevented
  // a separate receipt at admission. Missing payloads remain fenced.
  for (const source of [getLocalDraft(draftId), readDurableLocalDraft(draftId).draft]) {
    if (source?.ownerId !== ownerId || !source.accountSaveRequest) continue;
    const marker = source.accountSaveRequest,
      prior = receipts.get(receiptId(ownerId, draftId));
    if (
      (prior?.request && (marker.kind !== "project" || marker.key !== prior.request.key)) ||
      (prior?.attachedRequestKey && (marker.kind !== "attached" || marker.key !== prior.attachedRequestKey))
    )
      throw new StartReceiptRecoveryError(
        "This project has conflicting save records. Check your saved projects before continuing.",
      );
    if (!prior)
      receipts.set(receiptId(ownerId, draftId), {
        ownerId,
        draftId,
        projectId: source.accountProjectId ?? null,
        ...(marker.kind === "attached" ? { attachedRequestKey: marker.key } : {}),
      });
  }
  retireConfirmedReceipts(ownerId, draftId);
  return receipts.get(receiptId(ownerId, draftId)) ?? null;
}
export function readDraftFence(draftId: string) {
  if ([...receipts.values()].some((receipt) => receipt.draftId === draftId)) return true;
  // Older Home markers had no edit-fence bit. Before authentication, consult only
  // the local receipt metadata for a boolean fence; never expose an owner's destination.
  for (let index = 0; index < window.sessionStorage.length; index++) {
    const key = window.sessionStorage.key(index);
    if (!key || (key !== legacyReceiptKey && !key.startsWith("fluid.strategy-starts.v2:"))) continue;
    const raw = window.sessionStorage.getItem(key);
    if (!raw?.includes(draftId)) continue;
    const stored = readStoredReceipts(raw, null);
    if (!stored)
      throw new StartReceiptRecoveryError(
        "Saved recovery records could not be verified. Check account brands before continuing.",
      );
    if (stored.some((receipt) => receipt.draftId === draftId)) return true;
  }
  for (let index = 0; index < window.localStorage.length; index++) {
    const key = window.localStorage.key(index);
    if (
      (key?.startsWith("fluid.attached-starts.v1:") || key?.startsWith("fluid.project-source.v1:")) &&
      key.endsWith(`:${draftId}`)
    )
      return true;
    if (!key?.startsWith("fluid.project-starts.v3:")) continue;
    const raw = window.localStorage.getItem(key);
    if (!raw?.includes(draftId)) continue;
    const stored = readStoredReceipts(raw, null);
    if (!stored)
      throw new StartReceiptRecoveryError(
        "Saved recovery records could not be verified. Check your projects before continuing.",
      );
    if (stored.some((receipt) => receipt.draftId === draftId)) return true;
  }
  return false;
}
export function rememberReceipt(receipt: StartReceipt, requireDurable = false) {
  const owned = ownerReceipts(receipt.ownerId);
  if (
    !receipts.has(receiptId(receipt.ownerId, receipt.draftId)) &&
    (owned.filter((item) => item.projectId === null).length >= 200 || owned.length >= 250)
  ) {
    throw new StartReceiptRecoveryError(
      "Recovery storage is full for this account. No new account project or AI request was sent. Check the existing account saves before continuing; their recovery links remain available.",
    );
  }
  const source = getLocalDraft(receipt.draftId);
  const marker = receipt.request
    ? { kind: "project" as const, key: receipt.request.key }
    : receipt.attachedRequestKey
      ? { kind: "attached" as const, key: receipt.attachedRequestKey }
      : undefined;
  if (source && marker && !source.accountSaveRequest && (!source.ownerId || source.ownerId === receipt.ownerId))
    updateLocalDraft(receipt.draftId, { ownerId: receipt.ownerId, accountSaveRequest: marker });
  receipts.set(receiptId(receipt.ownerId, receipt.draftId), receipt);
  let durable = false;
  // Source-specific records cannot be clobbered by a different tab saving a
  // different source. Keep a small confirmed destination after the full request
  // retires, so neither creation endpoint can admit this source twice.
  const record = receipt.projectId
    ? {
        ownerId: receipt.ownerId,
        draftId: receipt.draftId,
        projectId: receipt.projectId,
        ...(receipt.attachedRequestKey ? { attachedRequestKey: receipt.attachedRequestKey } : {}),
      }
    : receipt;
  try {
    window.localStorage.setItem(sourceReceiptKey(receipt.ownerId, receipt.draftId), JSON.stringify(record));
    durable = true;
  } catch {
    /* Keep this tab's fence even when admission must stop. */
  }
  persistReceipts(receipt.ownerId);
  const shared = readDurableLocalDraft(receipt.draftId);
  if (requireDurable && !durable && (shared.storage !== "available" || shared.draft))
    throw new StartReceiptRecoveryError(
      "This project's recovery record could not be saved on this device. No project request was sent. Your prompt and files are kept in this tab.",
    );
}
export function forgetReceipt(receipt: StartReceipt) {
  // Called only after a known rejection with no committed project. If deleting
  // its shared fence fails, keep the exact request available for safe recovery.
  try {
    window.localStorage.removeItem(sourceReceiptKey(receipt.ownerId, receipt.draftId));
  } catch {
    return;
  }
  const source = getLocalDraft(receipt.draftId);
  if (source?.ownerId === receipt.ownerId && source.accountSaveRequest?.kind === "project")
    updateLocalDraft(receipt.draftId, { accountSaveRequest: undefined });
  receipts.delete(receiptId(receipt.ownerId, receipt.draftId));
  persistReceipts(receipt.ownerId);
}
export function hasDraftReceipt(draftId: string) {
  return [...receipts.values()].some((receipt) => receipt.draftId === draftId);
}
