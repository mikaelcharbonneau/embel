import { createLogoCreationController, type LogoCreationControllerInput, type LogoCreationState } from "@/components/logo-creation/creation-controller";
import { AccountRequestError } from "@/components/workspace/account-api";
import type { FontRecord } from "@/domain/logo-directions";
import { canonicalIdentityInput } from "../model/font-check-binding";
import { fontPurposeAllowed } from "../model/font-rights";

export type DirectionGenerationState = {
  generation: LogoCreationState;
  fonts: readonly FontRecord[] | null;
  loadingFonts: boolean;
  checking: boolean;
  canEstimate: boolean;
  canConfirm: boolean;
  unavailableReason: string | null;
  message: string | null;
};
const initial: DirectionGenerationState = Object.freeze({ generation: { phase: "idle" as const, quote: null, request: null, error: null }, fonts: null,
  loadingFonts: false, checking: false, canEstimate: false, canConfirm: false, unavailableReason: "Waiting for your saved workspace.", message: null });
export const emptyDirectionGeneration = () => initial;
const changedSource = "The permitted fonts or saved logo inputs changed. Review a new estimate before generating directions.";

/** Directions use the reviewed admission controller, with owned-font eligibility
 * and a second read of the reviewed font set before the explicit confirmation.
 * The server still freezes and verifies the authoritative sources atomically. */
export function createDirectionGenerationController(input: LogoCreationControllerInput) {
  const original = input.getWorkspace(), ownerId = original?.ownerId;
  let disposed = false, fontOperation: AbortController | null = null, checking = false;
  let fonts: readonly FontRecord[] | null = null, message: string | null = null, quotedFonts: string | null = null;
  let refreshedRequest: string | null = null, state = initial;
  const base = createLogoCreationController(input), listeners = new Set<() => void>();
  const current = () => !disposed && input.isCurrent() && input.getWorkspace()?.ownerId === ownerId && input.getWorkspace()?.projectId === input.projectId;
  const fingerprint = (rows: readonly FontRecord[]) => canonicalIdentityInput(rows);
  const reason = () => {
    const workspace = input.getWorkspace(), phase = base.getSnapshot().phase;
    if (!current() || !workspace) return "Waiting for your saved workspace.";
    if (!workspace.approvedLogo) return "Approve your logo before generating identity directions.";
    if (input.getPendingIntent()) return "Your original generation request is retained. Check it before starting another request.";
    if (input.hasUnsavedInputs()) return "Save or resolve your brief, logo or mix edits before reviewing a generation estimate.";
    if (input.isOperationAvailable ? !input.isOperationAvailable("identity.logo_directions") : workspace.capabilities.generate.status !== "available") return "Identity direction generation is currently unavailable. Your saved work is kept.";
    if (fontOperation) return "Checking permitted font versions…";
    if (fonts === null) return "Owned font permissions are unavailable. Refresh them before requesting an estimate.";
    if (!fonts.length) return "No owned fonts with reviewed commercial-use and display permissions are available.";
    if (phase !== "idle") return phase === "awaiting_confirmation" ? "Review the estimate before confirming this request." : "Finish the current request review first.";
    return null;
  };
  function emit() {
    if (!current()) return;
    const unavailableReason = reason();
    const next: DirectionGenerationState = { generation: base.getSnapshot(), fonts, loadingFonts: !!fontOperation, checking,
      canEstimate: unavailableReason === null, canConfirm: base.canConfirmQuote(), unavailableReason, message };
    if (canonicalIdentityInput(next) === canonicalIdentityInput(state)) return;
    state = next; for (const listener of listeners) listener();
  }
  const unsubscribe = base.subscribe(emit);
  async function readFonts(controller: AbortController): Promise<readonly FontRecord[] | null> {
    const rows = await input.client.listLogoFonts(controller.signal);
    if (!current() || controller.signal.aborted || fontOperation !== controller) return null;
    if (!rows) throw new AccountRequestError(503);
    const eligible = rows.filter(font => font.asset.ownerId === ownerId && font.asset.projectId === input.projectId && fontPurposeAllowed(font, "render"))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (new Set(rows.map(font => font.id)).size !== rows.length) throw new AccountRequestError(502);
    fonts = eligible;
    return eligible;
  }
  async function withFonts(action: (rows: readonly FontRecord[]) => Promise<void>) {
    if (!current() || fontOperation || checking) return;
    const controller = new AbortController(); fontOperation = controller; message = null; emit();
    try {
      const rows = await readFonts(controller);
      if (rows && current() && !controller.signal.aborted) await action(rows);
    } catch {
      if (current() && !controller.signal.aborted) { fonts = null; message = "Owned font permissions could not be verified. Your saved directions and original request are kept."; base.cancelQuote(); quotedFonts = null; }
    } finally { if (fontOperation === controller) { fontOperation = null; emit(); } }
  }
  emit();
  return {
    getSnapshot: () => current() ? state : initial,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async refreshFonts() {
      await withFonts(async rows => {
        if (base.getSnapshot().quote && quotedFonts !== fingerprint(rows)) { base.cancelQuote(); quotedFonts = null; message = changedSource; }
      });
    },
    async prepare() {
      if (!current() || reason() !== null) return;
      await withFonts(async rows => {
        const workspace = input.getWorkspace();
        if (!rows.length || !workspace?.approvedLogo || input.hasUnsavedInputs() || input.getPendingIntent()) return;
        quotedFonts = fingerprint(rows);
        await base.prepare({ operation: "directions", approvedLogoId: workspace.approvedLogo.id, expected: workspace.heads });
      });
    },
    async confirmQuote(quoteId: string) {
      const quote = base.getSnapshot().quote;
      if (!current() || !quote || quote.id !== quoteId || base.getSnapshot().phase !== "awaiting_confirmation") return;
      await withFonts(async rows => {
        if (!rows.length || quotedFonts !== fingerprint(rows)) { base.cancelQuote(); quotedFonts = null; message = changedSource; return; }
        await base.confirmQuote(quoteId);
      });
    },
    cancelQuote() {
      if (!current() || base.getSnapshot().phase === "admitting") return;
      fontOperation?.abort(); fontOperation = null; quotedFonts = null; base.cancelQuote(); emit();
    },
    refreshInputs() { base.refreshInputs(); emit(); },
    async returnToCostReview() { if (!current() || fontOperation || checking) return; message = null; await base.returnToCostReview(); emit(); },
    async checkRequest() {
      if (!current() || fontOperation || checking || !input.getPendingIntent()) return;
      checking = true; emit();
      try {
        await base.checkRequest();
        if (!current()) return;
        const request = base.getSnapshot().request;
        if (request && request.status !== "not_found" && !input.getPendingIntent() && refreshedRequest !== request.requestKey) {
          refreshedRequest = request.requestKey;
          const result = await input.refreshWorkspace();
          if (!current()) return;
          if (result !== "reloaded") message = result === "draft_blocked"
            ? "The request has settled. Its results are retained. Save or resolve your local edits, then refresh saved work to review them."
            : "The request has settled, but saved results could not be refreshed. Refresh saved work to review them.";
        }
      } finally { checking = false; emit(); }
    },
    dispose() { disposed = true; fontOperation?.abort(); fontOperation = null; unsubscribe(); base.dispose(); listeners.clear(); state = initial; },
  };
}
export type DirectionGenerationController = ReturnType<typeof createDirectionGenerationController>;
