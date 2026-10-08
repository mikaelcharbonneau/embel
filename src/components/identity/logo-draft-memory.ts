import { z } from "zod";
import {
  logoExpectedHeadsSchema, logoManualCommandSchema, logoProjectCreationInputSchema, logoProjectCreationStateSchema,
  logoReferenceSelectionSchema, logoTypeSchema, logoWorkspaceV2Schema, type LogoBriefDraft,
} from "@/domain/logo-workspace";
import { logoGenerationIntentSchema } from "@/domain/logo-jobs";
import { logoExportIntentSchema } from "@/domain/logo-deliverables";
import { freezeLogoRecord, logoCounterSchema, logoUuidSchema, logoHashSchema, logoManualEditSchema } from "@/domain/logo-vector";
import { AccountRequestError } from "@/components/workspace/account-api";

export { LogoDraftMemoryProvider, useLogoDraftMemory } from "./logo-draft-memory-context";
export type { LogoManualCommand } from "@/domain/logo-workspace";

// Editable form values are not persisted command bodies: incomplete input must
// survive navigation. Strict domain admission still applies to every intent.
const rawBriefSchema = z.strictObject({ name: z.string().max(65_536), activity: z.string().max(65_536), audience: z.string().max(65_536),
  personality: z.string().max(65_536), logoTypes: z.array(logoTypeSchema).max(7) });
const recordSchema = z.strictObject({
  workspace: logoWorkspaceV2Schema.nullable(), base: logoExpectedHeadsSchema.nullable(), brief: rawBriefSchema,
  references: z.array(logoReferenceSelectionSchema).max(100).refine(rows => new Set(rows.map(row => row.referenceId)).size === rows.length), dirty: z.boolean(),
  vectorDraft: z.strictObject({ baseVectorRevisionId: logoUuidSchema, edit: logoManualEditSchema }).nullable().optional(),
  directionDraft: z.strictObject({ approvedLogoId: logoUuidSchema, paletteVersionId: logoUuidSchema,
    typographyVersionId: logoUuidSchema, graphicsVersionId: logoUuidSchema, reviewedConsistencyHash: logoHashSchema.nullable() }).nullable().optional(),
  pendingIntent: logoGenerationIntentSchema.nullable(),
  pendingCreation: z.strictObject({ input: logoProjectCreationInputSchema, state: logoProjectCreationStateSchema.nullable() }).nullable(),
  pendingExport: logoExportIntentSchema.nullable(),
  pendingMutation: z.strictObject({ requestKey: logoUuidSchema, command: logoManualCommandSchema }).nullable(), conflict: z.boolean(),
});
export type LogoDraftRecord = Omit<z.infer<typeof recordSchema>, "brief"> & { brief: LogoBriefDraft };
export interface LogoDraftMemory {
  bind(binding: { ownerId: string; generation: number } | null): void;
  clear(): void;
  hasUnsaved(): boolean;
  subscribe(listener: () => void): () => void;
  get(projectId: string | null): LogoDraftRecord | null;
  set(projectId: string | null, record: LogoDraftRecord): void;
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const unsaved = (value: LogoDraftRecord) => value.dirty || value.conflict || !!value.vectorDraft || !!value.directionDraft || !!(value.pendingIntent || value.pendingCreation || value.pendingExport || value.pendingMutation);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const bindingSchema = z.strictObject({ ownerId: logoUuidSchema, generation: logoCounterSchema });
const MAX_RECORD_BYTES = 524_288, MAX_TOTAL_BYTES = 8_388_608, MAX_RECORDS = 20;

/** One root-provider lifetime. Never a singleton, browser store or credential store. */
export function createLogoDraftMemory(): LogoDraftMemory {
  let owner: string | null = null;
  let verified: z.infer<typeof bindingSchema> | null = null;
  const records = new Map<string | null, LogoDraftRecord>(), listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const key = (projectId: string | null) => projectId === null ? null : logoUuidSchema.parse(projectId);
  return {
    bind(input) {
      const next = input === null ? null : bindingSchema.parse(input);
      if (next && owner !== null && next.ownerId !== owner) records.clear();
      if (next) owner = next.ownerId;
      if (same(next, verified)) return;
      verified = next; notify();
    },
    clear() { records.clear(); owner = null; verified = null; notify(); },
    hasUnsaved: () => [...records.values()].some(unsaved),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get(projectId) { return verified ? records.get(key(projectId)) ?? null : null; },
    set(projectId, input) {
      if (!verified) throw new AccountRequestError(401);
      const slot = key(projectId), parsed = recordSchema.safeParse(input);
      if (!parsed.success) throw new AccountRequestError(422);
      const value: LogoDraftRecord = parsed.data;
      if (bytes(value) > MAX_RECORD_BYTES) throw new AccountRequestError(413);
      if (slot === null ? value.workspace !== null || value.base !== null || !!value.vectorDraft || !!value.directionDraft || value.pendingIntent !== null || value.pendingExport !== null || value.pendingMutation !== null
        : !value.workspace || value.workspace.ownerId !== verified.ownerId || value.workspace.projectId !== slot || !same(value.base, value.workspace.heads) || value.pendingCreation !== null) throw new AccountRequestError(422);
      if (value.pendingMutation && value.pendingMutation.requestKey !== value.pendingMutation.command.body.requestKey) throw new AccountRequestError(422);
      for (const intent of [value.pendingIntent, value.pendingExport, value.pendingMutation?.command.body]) {
        if (intent && !same(intent.expected, value.base)) throw new AccountRequestError(422);
      }
      const previous = records.get(slot);
      for (const field of ["pendingIntent", "pendingExport", "pendingMutation"] as const) {
        if (previous?.[field] && value[field] && !same(previous[field], value[field])) throw new AccountRequestError(409);
      }
      if (previous?.pendingCreation && value.pendingCreation && !same(previous.pendingCreation.input, value.pendingCreation.input)) throw new AccountRequestError(409);
      const creation = value.pendingCreation;
      if (creation?.state?.status === "succeeded") {
        const receipt = creation.state;
        if (receipt.requestKey !== creation.input.requestKey || receipt.workspace.ownerId !== verified.ownerId) throw new AccountRequestError(422);
        const destination = records.get(receipt.projectId);
        if (destination && unsaved(destination)) throw new AccountRequestError(409);
        const saved: LogoDraftRecord = freezeLogoRecord({ ...value, workspace: receipt.workspace, base: receipt.workspace.heads,
          dirty: !same(value.brief, creation.input.brief) || value.references.length > 0, pendingCreation: null, conflict: false });
        // Validate capacity before either change; notification observes the whole transfer.
        const others = [...records.entries()].filter(([id]) => id !== null && id !== receipt.projectId);
        if (others.length >= MAX_RECORDS || others.reduce((n, [, row]) => n + bytes(row), bytes(saved)) > MAX_TOTAL_BYTES) throw new AccountRequestError(413);
        records.delete(null); records.set(receipt.projectId, saved); notify(); return;
      }
      if (!previous && records.size >= MAX_RECORDS) throw new AccountRequestError(413);
      const total = [...records.entries()].reduce((n, [id, row]) => n + (id === slot ? 0 : bytes(row)), bytes(value));
      if (total > MAX_TOTAL_BYTES) throw new AccountRequestError(413);
      if (previous && same(previous, value)) return;
      records.set(slot, freezeLogoRecord(value)); notify();
    },
  };
}
