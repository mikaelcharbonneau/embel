import { z } from "zod";
import { canonicalIdentityInput } from "@/features/identity-directions/model/font-check-binding";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import { logoReferenceAspectSchema, logoWorkspaceV2Schema, type LogoReferenceAspect, type LogoWorkspaceV2 } from "@/domain/logo-workspace";
import { freezeLogoRecord, logoUuidSchema } from "@/domain/logo-vector";
import { createLogoInputsController, type LogoInputClient, type LogoInputsController } from "./controller";
import { LOGO_FONT_UPLOAD_MAX_BYTES, LOGO_REFERENCE_UPLOAD_MAX_BYTES } from "../model/contracts";
export type LogoInputDraft = { referenceFile: File | null; referencePermission: boolean; aspects: LogoReferenceAspect[]; fontFile: File | null; fontPermission: boolean; license: string; licenseUrl: string };
export const emptyLogoInputDraft = (): LogoInputDraft => ({ referenceFile: null, referencePermission: false, aspects: [], fontFile: null, fontPermission: false, license: "", licenseUrl: "" });
const accountSchema = z.strictObject({ status: z.literal("ready"), userId: logoUuidSchema, generation: z.number().int().nonnegative() });
const draftMetadata = z.strictObject({ referencePermission: z.boolean(), aspects: z.array(logoReferenceAspectSchema).max(4).refine(values => new Set(values).size === values.length), fontPermission: z.boolean(), license: z.string().max(262144), licenseUrl: z.string().max(2048) });
const draftUnsaved = (draft: LogoInputDraft) => !!(draft.referenceFile || draft.fontFile || draft.license || draft.licenseUrl || draft.referencePermission || draft.fontPermission || draft.aspects.length);
type Entry = { ownerId: string; generation: number; workspace: LogoWorkspaceV2; client: LogoInputClient; canWrite: boolean; controller: LogoInputsController; draft: LogoInputDraft };
/** One AccountSessionProvider lifetime. No module singleton, browser persistence,
 * view callback or automatic retry; File objects remain private tab memory. */
export function createLogoInputSession() {
  let owner: string | null = null, verified: VerifiedAccount | null = null;
  const entries = new Map<string, Entry>(), listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  const isCurrent = (account: VerifiedAccount) => !!verified && verified.userId === account.userId && verified.generation === account.generation;
  const visible = (entry: Entry) => !!verified && verified.userId === entry.ownerId && verified.generation === entry.generation;
  function clearEntries() { for (const entry of entries.values()) entry.controller.dispose(); entries.clear(); }
  return {
    bind(account: VerifiedAccount | null) {
      const next = account ? accountSchema.parse(account) : null;
      if (next && owner !== null && owner !== next.userId) clearEntries();
      // Fence first; callbacks cannot observe the old principal while suspending.
      const changed = !next || !verified || next.userId !== verified.userId || next.generation !== verified.generation;
      verified = next;
      if (changed) for (const entry of entries.values()) entry.controller.suspend();
      if (next) owner = next.userId;
      publish();
    },
    isCurrent,
    connect(account: VerifiedAccount, rawWorkspace: LogoWorkspaceV2, client: LogoInputClient, canWrite: boolean): LogoInputsController | null {
      if (!isCurrent(account)) return null;
      const workspace = freezeLogoRecord(logoWorkspaceV2Schema.parse(rawWorkspace));
      if (workspace.ownerId !== account.userId) return null;
      let entry = entries.get(workspace.projectId);
      if (entry) {
        const switched = entry.generation !== account.generation || entry.client !== client;
        if (switched) entry.controller.suspend();
        entry.generation = account.generation; entry.workspace = workspace; entry.client = client; entry.canWrite = canWrite;
        entry.controller.resume(); return entry.controller;
      }
      if (entries.size >= 20) return null;
      const slot = { ownerId: account.userId, generation: account.generation, workspace, client, canWrite, draft: Object.freeze(emptyLogoInputDraft()) } as Entry;
      const target = () => visible(slot) ? slot.client : null;
      const forwarding: LogoInputClient = {
        listLogoReferences: (...args) => target()?.listLogoReferences(...args) ?? Promise.resolve(null),
        listLogoFonts: (...args) => target()?.listLogoFonts(...args) ?? Promise.resolve(null),
        listCatalogLogoFonts: (...args) => target()?.listCatalogLogoFonts(...args) ?? Promise.resolve(null),
        listLogoInputRequests: (...args) => target()?.listLogoInputRequests(...args) ?? Promise.resolve(null),
        cancelLogoInputRequest: (...args) => target()?.cancelLogoInputRequest(...args) ?? Promise.resolve(null),
        readLogoInputRequest: (...args) => target()?.readLogoInputRequest(...args) ?? Promise.resolve(null),
        uploadLogoReference: (...args) => target()?.uploadLogoReference(...args) ?? Promise.resolve(null),
        uploadLogoFont: (...args) => target()?.uploadLogoFont(...args) ?? Promise.resolve(null),
        importCatalogLogoFont: (...args) => target()?.importCatalogLogoFont(...args) ?? Promise.resolve(null),
        previewLogoReference: (...args) => target()?.previewLogoReference(...args) ?? Promise.resolve(null),
      };
      slot.controller = createLogoInputsController({ ownerId: account.userId, projectId: workspace.projectId, client: forwarding,
        getWorkspace: () => slot.workspace, isCurrent: () => visible(slot), canWrite: () => slot.canWrite,
        createRequestKey: () => crypto.randomUUID(), onChange: publish,
        onRegistered(request, file) {
          // Clear only the form that still represents this exact confirmed request.
          // A separately changed form or another input type remains intact.
          const draft = slot.draft;
          if (request.kind === "reference_upload" && file === draft.referenceFile && draft.referencePermission && canonicalIdentityInput(draft.aspects) === canonicalIdentityInput(request.input.aspects))
            slot.draft = Object.freeze({ ...draft, referenceFile: null, referencePermission: false, aspects: [] });
          if (request.kind === "font_upload" && file === draft.fontFile && draft.fontPermission && draft.license === request.input.licenseText && (draft.licenseUrl || null) === request.input.licenseSourceUrl)
            slot.draft = Object.freeze({ ...draft, fontFile: null, fontPermission: false, license: "", licenseUrl: "" });
          publish();
        } });
      entry = slot; entries.set(workspace.projectId, entry); publish(); return entry.controller;
    },
    get(account: VerifiedAccount, projectId: string): LogoInputsController | null { const entry = entries.get(projectId); return isCurrent(account) && entry && visible(entry) ? entry.controller : null; },
    getDraft(account: VerifiedAccount, projectId: string): LogoInputDraft | null { const entry = entries.get(projectId); return isCurrent(account) && entry && visible(entry) ? entry.draft : null; },
    setDraft(account: VerifiedAccount, projectId: string, raw: LogoInputDraft): boolean {
      const entry = entries.get(projectId); if (!isCurrent(account) || !entry || !visible(entry)) return false;
      const { referenceFile, fontFile, ...metadata } = raw, result = draftMetadata.safeParse(metadata);
      if (!result.success || (referenceFile !== null && (!(referenceFile instanceof File) || referenceFile.size > LOGO_REFERENCE_UPLOAD_MAX_BYTES)) || (fontFile !== null && (!(fontFile instanceof File) || fontFile.size > LOGO_FONT_UPLOAD_MAX_BYTES))) return false;
      entry.draft = Object.freeze({ ...result.data, aspects: Object.freeze([...result.data.aspects]) as LogoReferenceAspect[], referenceFile, fontFile });
      publish(); return true;
    },
    hasUnsaved: () => [...entries.values()].some(entry => entry.controller.hasUnsaved() || draftUnsaved(entry.draft)),
    clear() { verified = null; owner = null; clearEntries(); publish(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type LogoInputSession = ReturnType<typeof createLogoInputSession>;
