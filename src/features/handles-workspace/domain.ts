import { z } from "zod";

export const platforms = [
  { id: "instagram", label: "Instagram", url: "https://www.instagram.com/" },
  { id: "tiktok", label: "TikTok", url: "https://www.tiktok.com/" },
  { id: "youtube", label: "YouTube", url: "https://www.youtube.com/" },
  { id: "x", label: "X", url: "https://x.com/" },
  { id: "linkedin", label: "LinkedIn", url: "https://www.linkedin.com/" },
] as const;
export const platformSchema = z.enum(["instagram", "tiktok", "youtube", "x", "linkedin"]);
export type HandlePlatform = z.infer<typeof platformSchema>;
const text = z.string().trim().min(1).max(160);
const date = z.iso.datetime({ offset: true });
const handle = z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/, "Use 1–64 letters, digits, dots, underscores or hyphens. Platform rules still need checking.");
const safeUrl = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, "Use an HTTP or HTTPS URL without credentials.");
export const handleSourceSchema = z.object({
  id: text, name: text, origin: z.enum(["manual", "names", "project"]),
  projectId: text.nullable(), projectTitle: text.nullable(),
}).strict();
export type HandleNameSource = z.infer<typeof handleSourceSchema>;
export const evidenceSchema = z.object({
  platform: platformSchema, handle,
  outcome: z.enum(["confirmed_available", "taken", "profile_missing", "failed", "unavailable", "unknown"]),
  authority: z.enum(["platform_api", "authorized_service", "public_profile", "user", "none"]),
  source: text.nullable(), sourceUrl: safeUrl.nullable(), method: text,
  checkedAt: date.nullable(), observedAt: date, detail: z.string().max(500),
}).strict().superRefine((evidence, ctx) => {
  const observedAt = Date.parse(evidence.observedAt);
  if (observedAt > Date.now()) {
    ctx.addIssue({ code: "custom", path: ["observedAt"], message: "An observation cannot be later than its local completion time." });
  }
  if (evidence.checkedAt && Date.parse(evidence.checkedAt) > observedAt) {
    ctx.addIssue({ code: "custom", path: ["checkedAt"], message: "A check cannot be later than its observation." });
  }
  if (["confirmed_available", "taken"].includes(evidence.outcome) &&
      (!["platform_api", "authorized_service"].includes(evidence.authority) || !evidence.source || !evidence.checkedAt)) {
    ctx.addIssue({ code: "custom", message: "A confirmed result requires a permitted source and actual check date." });
  }
});
export type HandleEvidence = z.infer<typeof evidenceSchema>;
export const entrySchema = z.object({
  platform: platformSchema, handle, favorite: z.boolean(), selected: z.boolean(),
  accountCreated: z.object({ declaredAt: date, url: safeUrl.nullable() }).strict().nullable(),
  evidence: z.array(evidenceSchema).max(100),
}).strict().superRefine((entry, ctx) => {
  if (entry.evidence.some(item => item.platform !== entry.platform || item.handle.toLowerCase() !== entry.handle.toLowerCase())) {
    ctx.addIssue({ code: "custom", message: "Evidence must match the exact platform and handle." });
  }
  // Zod can run this parent refinement after the URL's own refinement failed.
  if (entry.accountCreated?.url && safeUrl.safeParse(entry.accountCreated.url).success) {
    const host = new URL(entry.accountCreated.url).hostname.toLowerCase();
    const root = new URL(platforms.find(item => item.id === entry.platform)!.url).hostname.replace(/^www\./, "");
    if (host !== root && !host.endsWith(`.${root}`)) ctx.addIssue({ code: "custom", message: "The account URL must belong to this platform." });
  }
});
export type HandleEntry = z.infer<typeof entrySchema>;
export const bundleSchema = z.object({
  id: text, title: text, list: text, source: handleSourceSchema, savedAt: date,
  entries: z.array(entrySchema).min(1).max(5),
}).strict().superRefine((bundle, ctx) => {
  if (new Set(bundle.entries.map(entry => entry.platform)).size !== bundle.entries.length) ctx.addIssue({ code: "custom", message: "Choose one handle per platform in a bundle." });
});
export type HandleBundle = z.infer<typeof bundleSchema>;
const selectedImportsSchema = z.array(z.string().max(160)).max(30).refine(items => new Set(items).size === items.length, "Imported names must be unique.");
const selectedPlatformsSchema = z.array(platformSchema).max(5).refine(items => new Set(items).size === items.length, "Platforms must be unique.");
export const handleSearchOptionsSchema = z.object({
  prefixes: z.string().max(200), suffixes: z.string().max(200),
  separators: z.array(z.enum(["", ".", "_"])).max(3).refine(items => new Set(items).size === items.length, "Separators must be unique."),
}).strict();
export const savedHandleSearchSchema = z.object({
  id: z.uuid(), names: z.string().max(3000), imports: selectedImportsSchema, platforms: selectedPlatformsSchema, options: handleSearchOptionsSchema,
}).strict();
/** Authored input is retained even while a search is incomplete or locally invalid. */
export const handlesSearchSchema = z.object({
  names: z.string().max(3000), nameDraft: z.string().max(3000), imports: selectedImportsSchema,
  platforms: selectedPlatformsSchema, options: handleSearchOptionsSchema, title: z.string().max(160), list: z.string().max(160),
  savedSearches: z.array(savedHandleSearchSchema).max(20).refine(items => new Set(items.map(item => item.id)).size === items.length, "Saved search IDs must be unique."),
}).strict();
export type HandlesSearch = z.infer<typeof handlesSearchSchema>;
export const emptyHandlesSearch = (): HandlesSearch => ({ names: "", nameDraft: "", imports: [], platforms: platforms.map(platform => platform.id),
  options: { prefixes: "get, hello, try", suffixes: "hq, studio, co", separators: [""] }, title: "", list: "Personal list", savedSearches: [] });
export const workspaceSchema = z.object({ version: z.literal(1), bundles: z.array(bundleSchema).max(200), search: handlesSearchSchema.optional() }).strict().superRefine((state, ctx) => {
  if (new Set(state.bundles.map(bundle => bundle.id)).size !== state.bundles.length) ctx.addIssue({ code: "custom", message: "Bundle IDs must be unique." });
});
export type HandlesState = z.infer<typeof workspaceSchema>;
export const emptyHandlesState = (): HandlesState => ({ version: 1, bundles: [] });
export type HandleStatus = "confirmed_available" | "taken" | "to_check";
export function handleStatus(entry: HandleEntry): HandleStatus {
  const latest = entry.evidence.at(-1);
  if (!latest || !evidenceSchema.safeParse(latest).success || latest.platform !== entry.platform || latest.handle.toLowerCase() !== entry.handle.toLowerCase()) return "to_check";
  return latest.outcome === "confirmed_available" || latest.outcome === "taken" ? latest.outcome : "to_check";
}
export const statusLabels: Record<HandleStatus, string> = { confirmed_available: "Confirmed available", taken: "Taken", to_check: "To check" };
export const lastCheckedAt = (entry: HandleEntry): string | null => entry.evidence.slice().reverse().find(item => item.checkedAt !== null && evidenceSchema.safeParse(item).success)?.checkedAt ?? null;
export function createEntry(platform: HandlePlatform, value: string): HandleEntry {
  return entrySchema.parse({ platform, handle: value.replace(/^@/, "").trim(), favorite: false, selected: false, accountCreated: null, evidence: [] });
}
export type HandleMatrixRow = { id: string; source: HandleNameSource; variant: string; entries: HandleEntry[] };
export function buildHandleMatrix(sources: HandleNameSource[], chosenPlatforms: HandlePlatform[], variants = false): HandleMatrixRow[] {
  if (!sources.length || sources.length > 30) throw new Error("Enter or import between 1 and 30 names.");
  if (!chosenPlatforms.length) throw new Error("Choose at least one platform.");
  const columns = [...new Set(chosenPlatforms)].map(value => platformSchema.parse(value));
  const seen = new Set<string>();
  return sources.flatMap(raw => {
    const source = handleSourceSchema.parse(raw);
    // Only formatting, never a platform-validity or availability claim.
    const base = source.name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/^@/, "").replace(/\s/g, "").toLowerCase();
    const values = variants ? [base, `get${base}`, `${base}hq`] : [base];
    return values.flatMap((value, index) => {
      const key = `${source.id}:${value}`;
      if (seen.has(key)) return [];
      handle.parse(value); seen.add(key);
      return [{ id: key, source, variant: index === 0 ? "Exact name" : index === 1 ? "get prefix" : "hq suffix", entries: columns.map(platform => createEntry(platform, value)) }];
    });
  });
}
export function appendEvidence(entry: HandleEntry, raw: unknown): HandleEntry {
  const evidence = evidenceSchema.parse(raw);
  if (evidence.platform !== entry.platform || evidence.handle.toLowerCase() !== entry.handle.toLowerCase()) throw new Error("Check result does not match this handle.");
  return entrySchema.parse({ ...entry, evidence: [...entry.evidence, evidence] });
}
export function saveBundle(state: HandlesState, bundle: HandleBundle): HandlesState {
  return workspaceSchema.parse({ ...state, bundles: [...state.bundles, bundleSchema.parse(bundle)] });
}
export function updateBundleEntry(state: HandlesState, bundleId: string, platform: HandlePlatform, update: (entry: HandleEntry) => HandleEntry): HandlesState {
  const bundle = state.bundles.find(item => item.id === bundleId);
  if (!bundle || !bundle.entries.some(entry => entry.platform === platform)) throw new Error("This saved handle no longer exists.");
  return workspaceSchema.parse({ ...state, bundles: state.bundles.map(item => item.id !== bundleId ? item : { ...item, entries: item.entries.map(entry => entry.platform !== platform ? entry : entrySchema.parse(update(entry))) }) });
}
export function declareAccountCreated(entry: HandleEntry, url: string, declaredAt: string): HandleEntry {
  return entrySchema.parse({ ...entry, accountCreated: { declaredAt, url: url.trim() || null } });
}
export type LibraryFilter = "all" | "favorite" | "selected" | "account_created";
export function filterBundles(state: HandlesState, query = "", filter: LibraryFilter = "all", group = "all"): HandleBundle[] {
  const needle = query.trim().toLowerCase();
  return state.bundles.filter(bundle => (group === "all" || groupKey(bundle) === group) &&
    (!needle || [bundle.title, bundle.list, bundle.source.name, bundle.source.projectTitle ?? "", ...bundle.entries.map(entry => entry.handle)].some(value => value.toLowerCase().includes(needle))) &&
    (filter === "all" || bundle.entries.some(entry => filter === "favorite" ? entry.favorite : filter === "selected" ? entry.selected : Boolean(entry.accountCreated))));
}
export const groupKey = (bundle: HandleBundle) => bundle.source.projectId ? `project:${bundle.source.projectId}` : `list:${bundle.list}`;
export const groupLabel = (bundle: HandleBundle) => bundle.source.projectId ? bundle.source.projectTitle ?? "Linked project" : bundle.list;
