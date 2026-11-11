import { z } from "zod";
import {
  logoExpectedHeadsSchema,
  logoManualCommandSchema,
  logoReferenceSelectionSchema,
  logoTypeSchema,
  logoWorkspaceV2Schema,
  type LogoBriefDraft,
} from "@/domain/logo-workspace";
import { logoExportIntentSchema } from "@/domain/logo-deliverables";
import {
  freezeLogoRecord,
  logoCounterSchema,
  logoUuidSchema,
  logoHashSchema,
  logoManualEditSchema,
} from "@/domain/logo-vector";
import { AccountRequestError } from "@/components/workspace/account-api";

export { LogoDraftMemoryProvider, useLogoDraftMemory } from "./logo-draft-memory-context";
export type { LogoManualCommand } from "@/domain/logo-workspace";

// Editable form values are not persisted command bodies: incomplete input must
// survive navigation. Strict domain admission still applies to every intent.
const rawBriefSchema = z.strictObject({
  name: z.string().max(65_536),
  activity: z.string().max(65_536),
  audience: z.string().max(65_536),
  personality: z.string().max(65_536),
  logoTypes: z.array(logoTypeSchema).max(7),
});
const recordSchema = z.strictObject({
  workspace: logoWorkspaceV2Schema.nullable(),
  base: logoExpectedHeadsSchema.nullable(),
  brief: rawBriefSchema,
  references: z
    .array(logoReferenceSelectionSchema)
    .max(100)
    .refine((rows) => new Set(rows.map((row) => row.referenceId)).size === rows.length),
  dirty: z.boolean(),
  vectorDraft: z
    .strictObject({ baseVectorRevisionId: logoUuidSchema, edit: logoManualEditSchema })
    .nullable()
    .optional(),
  directionDraft: z
    .strictObject({
      approvedLogoId: logoUuidSchema,
      paletteVersionId: logoUuidSchema,
      typographyVersionId: logoUuidSchema,
      graphicsVersionId: logoUuidSchema,
      reviewedConsistencyHash: logoHashSchema.nullable(),
    })
    .nullable()
    .optional(),
  pendingExport: logoExportIntentSchema.nullable(),
  pendingMutation: z.strictObject({ requestKey: logoUuidSchema, command: logoManualCommandSchema }).nullable(),
  conflict: z.boolean(),
});
export type LogoDraftRecord = Omit<z.infer<typeof recordSchema>, "brief"> & { brief: LogoBriefDraft };
export interface LogoDraftMemory {
  bind(binding: { ownerId: string; generation: number } | null): void;
  clear(): void;
  hasUnsaved(): boolean;
  subscribe(listener: () => void): () => void;
  get(projectId: string): LogoDraftRecord | null;
  set(projectId: string, record: LogoDraftRecord): void;
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const unsaved = (value: LogoDraftRecord) =>
  value.dirty ||
  value.conflict ||
  !!value.vectorDraft ||
  !!value.directionDraft ||
  !!(value.pendingExport || value.pendingMutation);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const bindingSchema = z.strictObject({ ownerId: logoUuidSchema, generation: logoCounterSchema });
const MAX_RECORD_BYTES = 524_288,
  MAX_TOTAL_BYTES = 8_388_608,
  MAX_RECORDS = 20;

/** One root-provider lifetime. Never a singleton, browser store or credential store. */
export function createLogoDraftMemory(): LogoDraftMemory {
  let owner: string | null = null;
  let verified: z.infer<typeof bindingSchema> | null = null;
  let records = new Map<string, LogoDraftRecord>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const key = (projectId: string) => logoUuidSchema.parse(projectId);
  function commit(nextRecords: Map<string, LogoDraftRecord>, protectedKey: string) {
    let total = [...nextRecords.values()].reduce((size, row) => size + bytes(row), 0);
    // Saved baselines can be read again. Keep every edit and unresolved request.
    for (const [id, row] of nextRecords) {
      if (nextRecords.size <= MAX_RECORDS && total <= MAX_TOTAL_BYTES) break;
      if (id === protectedKey || unsaved(row)) continue;
      total -= bytes(row);
      nextRecords.delete(id);
    }
    // Plan eviction on copies so a rejected write cannot discard other work.
    if (nextRecords.size > MAX_RECORDS || total > MAX_TOTAL_BYTES) throw new AccountRequestError(413);
    records = nextRecords;
    notify();
  }
  return {
    bind(input) {
      const next = input === null ? null : bindingSchema.parse(input);
      if (next && owner !== null && next.ownerId !== owner) records.clear();
      if (next) owner = next.ownerId;
      if (same(next, verified)) return;
      verified = next;
      notify();
    },
    clear() {
      records.clear();
      owner = null;
      verified = null;
      notify();
    },
    hasUnsaved: () => [...records.values()].some(unsaved),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get(projectId) {
      return verified ? (records.get(key(projectId)) ?? null) : null;
    },
    set(projectId, input) {
      if (!verified) throw new AccountRequestError(401);
      const slot = key(projectId),
        parsed = recordSchema.safeParse(input);
      if (!parsed.success) throw new AccountRequestError(422);
      const value: LogoDraftRecord = parsed.data;
      if (bytes(value) > MAX_RECORD_BYTES) throw new AccountRequestError(413);
      if (
        !value.workspace ||
        value.workspace.ownerId !== verified.ownerId ||
        value.workspace.projectId !== slot ||
        !same(value.base, value.workspace.heads)
      )
        throw new AccountRequestError(422);
      if (value.pendingMutation && value.pendingMutation.requestKey !== value.pendingMutation.command.body.requestKey)
        throw new AccountRequestError(422);
      for (const intent of [value.pendingExport, value.pendingMutation?.command.body]) {
        if (intent && !same(intent.expected, value.base)) throw new AccountRequestError(422);
      }
      const previous = records.get(slot);
      for (const field of ["pendingExport", "pendingMutation"] as const) {
        if (previous?.[field] && value[field] && !same(previous[field], value[field]))
          throw new AccountRequestError(409);
      }
      if (previous && same(previous, value)) return;
      commit(new Map(records).set(slot, freezeLogoRecord(value)), slot);
    },
  };
}
