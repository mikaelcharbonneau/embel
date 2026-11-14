import type { FontRecord } from "@/domain/logo-directions";
import { fontRecordSchema } from "@/domain/logo-directions";
import {
  logoReferencePageSchema,
  logoReferenceRegistrationSchema,
  type LogoReferenceAspect,
  type LogoReferenceRegistration,
  type LogoWorkspaceV2,
} from "@/domain/logo-workspace";
import { canonicalIdentityInput } from "@/features/identity-directions/model/font-check-binding";
import { z } from "zod";
import { freezeLogoRecord } from "@/domain/logo-vector";
import {
  catalogLogoFontSchema,
  logoInputRequestPageSchema,
  logoInputRequestSchema,
  logoInputRequestStateSchema,
  referenceUploadInputSchema,
  uploadLogoFontInputSchema,
  importCatalogLogoFontInputSchema,
  LOGO_FONT_UPLOAD_MAX_BYTES,
  LOGO_REFERENCE_UPLOAD_MAX_BYTES,
  type CatalogLogoFont,
  type ImportCatalogLogoFontInput,
  type LogoInputRequest,
  type LogoInputRequestPage,
  type LogoInputRequestState,
  type UploadLogoFontInput,
  type UploadLogoReferenceInput,
} from "../model/contracts";
const REFERENCE_PERMISSION = "I have permission to use and process this image.";
const FONT_PERMISSION = "I have permission to upload and use this font and its license.";
type InputPreview = { url: string; release(): void };
export type LogoInputClient = {
  listLogoReferences(
    query?: { cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<z.infer<typeof logoReferencePageSchema> | null>;
  listLogoFonts(signal?: AbortSignal): Promise<FontRecord[] | null>;
  listCatalogLogoFonts(signal?: AbortSignal): Promise<CatalogLogoFont[] | null>;
  listLogoInputRequests(
    query?: { cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<LogoInputRequestPage | null>;
  cancelLogoInputRequest(request: LogoInputRequest, signal?: AbortSignal): Promise<LogoInputRequestState | null>;
  readLogoInputRequest(requestKey: string, signal?: AbortSignal): Promise<LogoInputRequestState | null>;
  uploadLogoReference(
    input: UploadLogoReferenceInput & { file: File },
    signal?: AbortSignal,
  ): Promise<LogoReferenceRegistration | null>;
  uploadLogoFont(input: UploadLogoFontInput & { file: File }, signal?: AbortSignal): Promise<FontRecord | null>;
  importCatalogLogoFont(input: ImportCatalogLogoFontInput, signal?: AbortSignal): Promise<FontRecord | null>;
  previewLogoReference(input: LogoReferenceRegistration, signal?: AbortSignal): Promise<InputPreview | null>;
};
type LogoInputsState = {
  busy: boolean;
  loading: boolean;
  references: LogoReferenceRegistration[];
  fonts: FontRecord[];
  catalog: CatalogLogoFont[];
  referenceCursor: string | null;
  requestCursor: string | null;
  unresolved: LogoInputRequest[];
  pending: LogoInputRequest | null;
  pendingStatus: "uncertain" | "not_found" | "pending" | "rejected" | null;
  hasOriginalFile: boolean;
  error: string | null;
  message: string | null;
};
const empty = (): LogoInputsState => ({
  busy: false,
  loading: false,
  references: [],
  fonts: [],
  catalog: [],
  referenceCursor: null,
  requestCursor: null,
  unresolved: [],
  pending: null,
  pendingStatus: null,
  hasOriginalFile: false,
  error: null,
  message: null,
});
const hidden = empty(),
  same = (a: unknown, b: unknown) => canonicalIdentityInput(a) === canonicalIdentityInput(b);
export function createLogoInputsController(options: {
  ownerId: string;
  projectId: string;
  client: LogoInputClient;
  getWorkspace(): LogoWorkspaceV2 | null;
  isCurrent(): boolean;
  canWrite(): boolean;
  createRequestKey(): string;
  onChange?(): void;
  onRegistered?(request: LogoInputRequest, file: File | null): void;
}) {
  let state = empty(),
    disposed = false,
    operation: AbortController | null = null,
    originalFile: File | null = null;
  const listeners = new Set<() => void>();
  let attachmentEpoch = 0;
  const current = () => !disposed && options.isCurrent();
  function update(next: Partial<LogoInputsState>) {
    if (!current()) return;
    state = { ...state, ...next };
    for (const listener of listeners) listener();
    options.onChange?.();
  }
  const owned = (value: { ownerId: string; projectId: string }) =>
    value.ownerId === options.ownerId && value.projectId === options.projectId;
  function writable(): LogoWorkspaceV2 | null {
    const w = options.getWorkspace();
    return current() && options.canWrite() && w && owned(w) && w.capabilities.upload.status === "available" ? w : null;
  }
  async function fingerprint(file: File, font: boolean) {
    if (
      !(file instanceof File) ||
      file.size < (font ? 12 : 1) ||
      file.size > (font ? LOGO_FONT_UPLOAD_MAX_BYTES : LOGO_REFERENCE_UPLOAD_MAX_BYTES) ||
      !(font ? ["font/ttf", "font/otf"] : ["image/png", "image/jpeg", "image/webp"]).includes(file.type)
    )
      throw Error("Choose a supported file within the displayed size limit.");
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return {
      contentHash: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      byteLength: file.size,
      mimeType: file.type,
    };
  }
  function acceptResult(request: LogoInputRequest, value: unknown) {
    if (request.kind === "reference_upload") {
      const ref = logoReferenceRegistrationSchema.parse(value);
      if (
        !owned(ref.asset) ||
        ref.asset.contentHash !== request.file.contentHash ||
        ref.sourceKind !== "upload" ||
        !same(ref.aspects, request.input.aspects)
      )
        throw Error("The saved reference does not match the original request.");
      update({
        references: [...state.references.filter((row) => row.referenceId !== ref.referenceId), ref],
        message: "Reference saved. Choose its aspects and save references to use it.",
      });
    } else {
      const font = fontRecordSchema.parse(value);
      if (
        !owned(font.asset) ||
        font.asset.contentHash !== request.file.contentHash ||
        font.source !== (request.kind === "font_catalog" ? "free_catalog" : "user_upload")
      )
        throw Error("The saved font does not match the original request.");
      update({
        fonts: [...state.fonts.filter((row) => row.id !== font.id), font],
        message:
          request.kind === "font_catalog"
            ? "Reviewed free-commercial font saved to this project."
            : "Font and license saved. Permissions remain unreviewed and the font cannot be used yet.",
      });
    }
    options.onRegistered?.(request, originalFile);
    originalFile = null;
    update({
      pending: null,
      pendingStatus: null,
      hasOriginalFile: false,
      unresolved: state.unresolved.filter((row) => row.input.requestKey !== request.input.requestKey),
      error: null,
    });
  }
  async function dispatch(request: LogoInputRequest, signal: AbortSignal) {
    const client = options.client;
    const result =
      request.kind === "font_catalog"
        ? await client.importCatalogLogoFont(request.input, signal)
        : request.kind === "reference_upload"
          ? await client.uploadLogoReference({ ...request.input, file: originalFile! }, signal)
          : await client.uploadLogoFont({ ...request.input, file: originalFile! }, signal);
    if (!current() || signal.aborted) return;
    if (!result) throw Error("The upload outcome is not confirmed.");
    acceptResult(request, result);
  }
  async function start(
    makeRequest: (workspace: LogoWorkspaceV2) => Promise<{ request: LogoInputRequest; file: File | null }>,
  ) {
    if (operation || state.pending) return;
    const workspace = writable();
    if (!workspace) {
      update({ error: "Saving inputs needs connected owned storage and current saved work." });
      return;
    }
    const controller = new AbortController();
    operation = controller;
    update({ busy: true, error: null, message: null });
    try {
      const next = await makeRequest(workspace);
      if (!current() || controller.signal.aborted) return;
      const request = freezeLogoRecord(logoInputRequestSchema.parse(next.request));
      if (!same(options.getWorkspace()?.heads, request.input.expected))
        throw Error("Saved inputs changed. Review the current workspace before uploading.");
      originalFile = next.file;
      update({ pending: request, pendingStatus: "uncertain", hasOriginalFile: !!originalFile });
      await dispatch(request, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted)
        update({
          error: state.pending
            ? "The outcome is not confirmed. Check the original request before retrying; its exact inputs are kept."
            : error instanceof Error
              ? error.message
              : "The input could not be prepared.",
        });
    } finally {
      if (operation === controller) {
        operation = null;
        update({ busy: false });
      }
    }
  }
  async function check() {
    const pending = state.pending;
    if (!current() || !pending || operation) return;
    const controller = new AbortController();
    operation = controller;
    update({ busy: true, error: null });
    try {
      const raw = await options.client.readLogoInputRequest(pending.input.requestKey, controller.signal);
      if (!current() || controller.signal.aborted) return;
      if (!raw) throw Error("The original input request could not be checked.");
      const value = logoInputRequestStateSchema.parse(raw);
      if (value.status !== "not_found" && (!owned(value) || !same(value.request, pending)))
        throw Error("The recovery record does not match this original input.");
      if (value.status === "succeeded") acceptResult(pending, value.result);
      else
        update({
          pendingStatus: value.status,
          message:
            value.status === "rejected"
              ? value.reason === "cancelled_by_user"
                ? "The original request was cancelled. Close this checked request before preparing another input."
                : "The original request was closed because saved inputs changed. Refresh your workspace before a new upload."
              : value.status === "pending"
                ? "The original input is reserved but not registered. Retry only this unchanged request."
                : "No request is recorded. You may explicitly retry the original inputs.",
        });
    } catch (error) {
      if (!controller.signal.aborted)
        update({ error: error instanceof Error ? error.message : "The original input request could not be checked." });
    } finally {
      if (operation === controller) {
        operation = null;
        update({ busy: false });
      }
    }
  }
  return {
    getSnapshot: () => (current() ? state : hidden),
    hasUnsaved: () => state.pending !== null || state.busy,
    suspend() {
      attachmentEpoch++;
      operation?.abort();
      operation = null;
      state = {
        ...state,
        busy: false,
        loading: false,
        ...(state.pending ? { pendingStatus: "uncertain" as const } : {}),
      };
      for (const listener of listeners) listener();
      options.onChange?.();
    },
    resume() {
      if (current()) {
        for (const listener of listeners) listener();
        options.onChange?.();
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refresh() {
      if (!current() || operation) return;
      const controller = new AbortController();
      operation = controller;
      update({ loading: true, error: null });
      const responses = await Promise.allSettled([
        options.client.listLogoReferences({}, controller.signal),
        options.client.listLogoFonts(controller.signal),
        options.client.listCatalogLogoFonts(controller.signal),
        options.client.listLogoInputRequests({}, controller.signal),
      ]);
      if (current() && !controller.signal.aborted) {
        let failures = 0;
        responses.forEach((response, index) => {
          try {
            if (response.status !== "fulfilled" || response.value === null) throw Error("Unavailable");
            if (index === 0) {
              const page = logoReferencePageSchema.parse(response.value);
              if (!owned(page)) throw Error("Foreign references");
              update({ references: page.items, referenceCursor: page.nextCursor });
            }
            if (index === 1) {
              const fonts = z.array(fontRecordSchema).max(100).parse(response.value);
              if (fonts.some((row) => !owned(row.asset))) throw Error("Foreign fonts");
              update({ fonts });
            }
            if (index === 2) update({ catalog: z.array(catalogLogoFontSchema).max(100).parse(response.value) });
            if (index === 3) {
              const page = logoInputRequestPageSchema.parse(response.value);
              if (!owned(page)) throw Error("Foreign requests");
              update({
                unresolved: page.items.flatMap((row) => (row.status === "pending" ? [row.request] : [])),
                requestCursor: page.nextCursor,
              });
            }
          } catch {
            failures++;
          }
        });
        if (failures)
          update({
            error:
              "Some saved inputs or sources are unavailable. Existing selections are kept; refresh to try reading again.",
          });
      }
      if (operation === controller) {
        operation = null;
        update({ loading: false });
      }
    },
    uploadReference: (file: File, aspects: LogoReferenceAspect[], permission: boolean) =>
      start(async (workspace) => {
        if (!permission) throw Error("Confirm that you have permission to use and process this image.");
        const input = referenceUploadInputSchema.parse({
          requestKey: options.createRequestKey(),
          expected: workspace.heads,
          aspects,
          rightsDeclaration: REFERENCE_PERMISSION,
        });
        return {
          request: { kind: "reference_upload", input, file: await fingerprint(file, false) } as LogoInputRequest,
          file,
        };
      }),
    uploadFont: (file: File, licenseText: string, licenseSourceUrl: string | null, permission: boolean) =>
      start(async (workspace) => {
        if (!permission) throw Error("Confirm that you have permission to upload this font and its license.");
        const input = uploadLogoFontInputSchema.parse({
          requestKey: options.createRequestKey(),
          expected: workspace.heads,
          licenseText,
          licenseSourceUrl,
          rightsDeclaration: FONT_PERMISSION,
        });
        return {
          request: { kind: "font_upload", input, file: await fingerprint(file, true) } as LogoInputRequest,
          file,
        };
      }),
    importCatalogFont: (catalogFontId: string) =>
      start(async (workspace) => {
        const source = state.catalog.find((row) => row.id === catalogFontId);
        if (!source) throw Error("Read the reviewed catalog before choosing a font.");
        const input = importCatalogLogoFontInputSchema.parse({
          requestKey: options.createRequestKey(),
          expected: workspace.heads,
          catalogFontId,
        });
        return {
          request: {
            kind: "font_catalog",
            input,
            file: {
              contentHash: source.rights.fontContentHash,
              byteLength: source.byteLength,
              mimeType: source.mimeType,
            },
          },
          file: null,
        };
      }),
    check,
    async cancel() {
      const pending = state.pending;
      if (!pending || operation || !current()) return;
      const controller = new AbortController();
      operation = controller;
      update({ busy: true, error: null, pendingStatus: "uncertain" });
      try {
        const raw = await options.client.cancelLogoInputRequest(pending, controller.signal);
        if (!current() || controller.signal.aborted) return;
        const value = logoInputRequestStateSchema.parse(raw);
        if (
          (value.status !== "succeeded" && value.status !== "rejected") ||
          !owned(value) ||
          !same(value.request, pending)
        )
          throw Error("Cancellation was not confirmed for this exact input.");
        if (value.status === "succeeded") acceptResult(pending, value.result);
        else
          update({
            pendingStatus: "rejected",
            message:
              "This exact input request is closed. Already uploaded bytes are retained, and a delayed request cannot register another input. Close the checked request before starting a new one.",
          });
      } catch {
        if (!controller.signal.aborted)
          update({
            error: "Cancellation is not confirmed. The original request and file are kept; check it before proceeding.",
          });
      } finally {
        if (operation === controller) {
          operation = null;
          update({ busy: false });
        }
      }
    },
    async recover(requestKey: string) {
      if (operation || state.pending || !current()) return;
      const request = state.unresolved.find((row) => row.input.requestKey === requestKey);
      if (!request) return;
      originalFile = null;
      update({
        pending: request,
        pendingStatus: "pending",
        hasOriginalFile: false,
        message: "Check the original request. To retry an upload, choose the original file again; its hash must match.",
      });
      await check();
    },
    async attachOriginalFile(file: File) {
      const pending = state.pending;
      if (!pending || pending.kind === "font_catalog" || operation || !current()) return;
      const epoch = ++attachmentEpoch;
      try {
        const identity = await fingerprint(file, pending.kind === "font_upload");
        if (!current() || state.pending !== pending || epoch !== attachmentEpoch) return;
        if (!same(identity, pending.file)) throw Error("This file does not match the original file's bytes and type.");
        originalFile = file;
        update({ hasOriginalFile: true, error: null });
      } catch (error) {
        if (epoch !== attachmentEpoch) return;
        originalFile = null;
        update({
          hasOriginalFile: false,
          error: error instanceof Error ? error.message : "The original file could not be checked.",
        });
      }
    },
    async retry() {
      const pending = state.pending;
      if (
        !pending ||
        operation ||
        !current() ||
        !options.canWrite() ||
        !["not_found", "pending"].includes(state.pendingStatus ?? "")
      )
        return;
      if (pending.kind !== "font_catalog" && !originalFile) {
        update({ error: "Choose the original file before retrying this unchanged request." });
        return;
      }
      const controller = new AbortController();
      operation = controller;
      update({ busy: true, error: null, pendingStatus: "uncertain" });
      try {
        await dispatch(pending, controller.signal);
      } catch {
        if (!controller.signal.aborted)
          update({ error: "The outcome is not confirmed. Check the same original request before another retry." });
      } finally {
        if (operation === controller) {
          operation = null;
          update({ busy: false });
        }
      }
    },
    dismissRejected() {
      if (state.pendingStatus !== "rejected" || operation) return;
      const key = state.pending?.input.requestKey;
      originalFile = null;
      update({
        pending: null,
        pendingStatus: null,
        hasOriginalFile: false,
        unresolved: state.unresolved.filter((row) => row.input.requestKey !== key),
        error: null,
      });
    },
    async loadMore(kind: "references" | "requests") {
      const cursor = kind === "references" ? state.referenceCursor : state.requestCursor;
      if (!cursor || operation || !current()) return;
      const controller = new AbortController();
      operation = controller;
      update({ loading: true, error: null });
      try {
        if (kind === "references") {
          const page = logoReferencePageSchema.parse(
            await options.client.listLogoReferences({ cursor }, controller.signal),
          );
          if (!owned(page)) throw Error("Foreign references");
          if (current() && !controller.signal.aborted)
            update({
              references: [
                ...state.references,
                ...page.items.filter((row) => !state.references.some((saved) => saved.referenceId === row.referenceId)),
              ],
              referenceCursor: page.nextCursor,
            });
        } else {
          const page = logoInputRequestPageSchema.parse(
            await options.client.listLogoInputRequests({ cursor }, controller.signal),
          );
          if (!owned(page)) throw Error("Foreign requests");
          if (current() && !controller.signal.aborted)
            update({
              unresolved: [
                ...state.unresolved,
                ...page.items.flatMap((row) =>
                  row.status === "pending" &&
                  !state.unresolved.some((saved) => saved.input.requestKey === row.requestKey)
                    ? [row.request]
                    : [],
                ),
              ],
              requestCursor: page.nextCursor,
            });
        }
      } catch {
        if (!controller.signal.aborted)
          update({ error: "The next page could not be read. Your current inputs are kept." });
      } finally {
        if (operation === controller) {
          operation = null;
          update({ loading: false });
        }
      }
    },
    dispose() {
      disposed = true;
      attachmentEpoch++;
      operation?.abort();
      operation = null;
      originalFile = null;
      state = empty();
      listeners.clear();
    },
  };
}
export type LogoInputsController = ReturnType<typeof createLogoInputsController>;
