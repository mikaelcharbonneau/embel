import { z } from "zod";
import {
  identityBasisSchema, identityColorsSchema, identityPreferencesSchema, identityTypographySchema,
  refineIdentityComponentSchema, updateIdentityPreferencesSchema,
  type IdentityColors, type IdentityPreferences, type IdentityTypography,
} from "@/domain/project-identity";

const id = z.uuid().transform(value => value.toLowerCase());
const ownership = { ownerId: id, projectId: id };
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rawNote = z.string().max(8192);
const preferenceFormSchema = z.strictObject({ creativeLocale: z.string().max(128), notes: rawNote, avoidanceNotes: rawNote });
const colorFormSchema = z.strictObject({
  swatches: z.array(z.strictObject({ key: z.string().max(64), name: z.string().max(480), hex: z.string().max(64) })).max(16), usageNotes: rawNote,
});
const typographyFormSchema = z.strictObject({
  styles: z.array(z.strictObject({ key: z.string().max(64), role: z.string().max(480), family: z.string().max(640), weight: z.string().max(32), style: z.enum(["normal", "italic", "oblique"]) })).max(8), usageNotes: rawNote,
});
export type IdentityPreferenceForm = z.infer<typeof preferenceFormSchema>;
export type IdentityColorForm = z.infer<typeof colorFormSchema>;
export type IdentityTypographyForm = z.infer<typeof typographyFormSchema>;

const preferenceKeySchema = z.strictObject({ kind: z.literal("preferences"), ...ownership });
const componentKeySchema = z.strictObject({ kind: z.literal("component"), ...ownership, baseSystemVersionId: id, component: z.enum(["colors", "typography"]) });
export type IdentityDraftKey = z.infer<typeof preferenceKeySchema> | z.infer<typeof componentKeySchema>;
const refinementPendingSchema = z.strictObject({ request: refineIdentityComponentSchema, basis: identityBasisSchema, previousSelectionId: id.nullable() });
const preferenceDraftSchema = preferenceKeySchema.extend({
  baselineRevision: counter, baseline: identityPreferencesSchema, value: preferenceFormSchema,
  pending: z.strictObject({ request: updateIdentityPreferencesSchema }).nullable(),
});
const colorDraftSchema = componentKeySchema.extend({ component: z.literal("colors"), baseline: identityColorsSchema, value: colorFormSchema, pending: refinementPendingSchema.nullable() });
const typographyDraftSchema = componentKeySchema.extend({ component: z.literal("typography"), baseline: identityTypographySchema, value: typographyFormSchema, pending: refinementPendingSchema.nullable() });
export type IdentityPreferenceDraft = z.infer<typeof preferenceDraftSchema>;
export type IdentityColorDraft = z.infer<typeof colorDraftSchema>;
export type IdentityTypographyDraft = z.infer<typeof typographyDraftSchema>;
export type IdentityDraft = IdentityPreferenceDraft | IdentityColorDraft | IdentityTypographyDraft;

export function identityPreferenceForm(input: IdentityPreferences): IdentityPreferenceForm {
  return { creativeLocale: input.creativeLocale, notes: input.notes, avoidanceNotes: input.avoidanceNotes };
}
export function identityColorForm(input: IdentityColors): IdentityColorForm {
  return { swatches: input.swatches.map(swatch => ({ ...swatch })), usageNotes: input.usageNotes };
}
export function identityTypographyForm(input: IdentityTypography): IdentityTypographyForm {
  return { styles: input.styles.map(style => ({ ...style, weight: String(style.weight) })), usageNotes: input.usageNotes };
}
export function parseIdentityTypographyForm(input: IdentityTypographyForm): IdentityTypography {
  return identityTypographySchema.parse({ styles: input.styles.map(style => ({ ...style, weight: /^\d{1,4}$/.test(style.weight) ? Number(style.weight) : Number.NaN })), usageNotes: input.usageNotes });
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export function identityDraftChanged(draft: IdentityDraft): boolean {
  if (draft.pending) return true;
  const baseline = draft.kind === "preferences" ? identityPreferenceForm(draft.baseline)
    : draft.component === "colors" ? identityColorForm(draft.baseline) : identityTypographyForm(draft.baseline);
  return !same(baseline, draft.value);
}
export function identityDraftKey(input: IdentityDraftKey): IdentityDraftKey {
  const scope = { ownerId: input.ownerId, projectId: input.projectId };
  return input.kind === "preferences" ? preferenceKeySchema.parse({ kind: input.kind, ...scope })
    : componentKeySchema.parse({ kind: input.kind, ...scope, baseSystemVersionId: input.baseSystemVersionId, component: input.component });
}
const encodedKey = (key: IdentityDraftKey) => JSON.stringify(identityDraftKey(key));
const encodedScope = (ownerId: string, projectId: string) => `${id.parse(ownerId)}:${id.parse(projectId)}`;
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const draftSchema = z.union([preferenceDraftSchema, colorDraftSchema, typographyDraftSchema]).superRefine((draft, ctx) => {
  if (!draft.pending) return;
  const issue = () => ctx.addIssue({ code: "custom", message: "An uncertain request must retain its exact owned draft and original observation" });
  if (draft.kind === "preferences") {
    const normalized = identityPreferencesSchema.safeParse({ version: 1, ...draft.value });
    if (draft.pending.request.expectedPreferencesRevision !== draft.baselineRevision || !normalized.success || !same(normalized.data, draft.pending.request.preferences)) issue();
    return;
  }
  const { request, basis, previousSelectionId } = draft.pending;
  if (request.baseSystemVersionId.toLowerCase() !== draft.baseSystemVersionId || request.component !== draft.component || basis.ownerId.toLowerCase() !== draft.ownerId || basis.projectId.toLowerCase() !== draft.projectId
    || (request.expectedIdentityRevision === 0) !== (previousSelectionId === null)) issue();
  try {
    const value = draft.component === "colors" ? identityColorsSchema.parse(draft.value) : parseIdentityTypographyForm(draft.value);
    if (!same(value, request.input)) issue();
  } catch { issue(); }
}).transform(freeze);
const empty: readonly IdentityDraft[] = Object.freeze([]);

/** Provider-local edit buffers only. No browser persistence, file data or account singleton. */
export function createIdentityDraftMemory() {
  const entries = new Map<string, IdentityDraft>();
  const snapshots = new Map<string, readonly IdentityDraft[]>();
  const listeners = new Set<() => void>();
  const notify = () => { snapshots.clear(); for (const listener of listeners) listener(); };
  return {
    get(key: IdentityDraftKey): IdentityDraft | null { return entries.get(encodedKey(key)) ?? null; },
    list(ownerId: string, projectId: string): readonly IdentityDraft[] {
      const key = encodedScope(ownerId, projectId), cached = snapshots.get(key);
      if (cached) return cached;
      const found = [...entries.values()].filter(entry => encodedScope(entry.ownerId, entry.projectId) === key);
      if (!found.length) return empty;
      const result = Object.freeze(found);
      snapshots.set(key, result); return result;
    },
    set(input: IdentityDraft): boolean {
      const draft = draftSchema.parse(input);
      // Stored material bases originate in bounded account responses. Refuse excess
      // local memory explicitly; never trim a pending intent or evict dirty work.
      if (new TextEncoder().encode(JSON.stringify(draft)).byteLength > 2 * 1024 * 1024) return false;
      const key = encodedKey(draft), previous = entries.get(key);
      if (previous && same(previous, draft)) return true;
      if (previous?.pending && !same(previous.pending, draft.pending)) return false;
      if (previous && identityDraftChanged(previous) && (!same(previous.baseline, draft.baseline)
        || (previous.kind === "preferences" && draft.kind === "preferences" && previous.baselineRevision !== draft.baselineRevision))) return false;
      if (previous?.kind === "component" && !same(previous.baseline, draft.baseline)) return false;
      if (!previous && entries.size >= 20) {
        const clean = [...entries].find(([, entry]) => !identityDraftChanged(entry));
        if (!clean) return false;
        entries.delete(clean[0]);
      }
      entries.set(key, draft); notify(); return true;
    },
    // Explicit save resolution/discard is the only way to clear uncertain evidence.
    remove(key: IdentityDraftKey): void { if (entries.delete(encodedKey(key))) notify(); },
    hasUnsaved(): boolean { return [...entries.values()].some(identityDraftChanged); },
    clear(): void { if (entries.size) { entries.clear(); notify(); } },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type IdentityDraftMemory = ReturnType<typeof createIdentityDraftMemory>;
