"use client";

import { useSyncExternalStore } from "react";
import { z } from "zod";
import { contextSnapshotSchema, personalitySchema, type ProjectScope } from "@/domain/projects";
import { conversationSchema, initialConversation } from "@/domain/conversation";

export const scopeDetails: { value: ProjectScope; label: string; description: string; icon: "brands" | "names" | "layers" }[] = [
  { value: "complete_brand", label: "Complete brand", description: "Build the strategy, name, and visual identity together.", icon: "brands" },
  { value: "naming_only", label: "Naming", description: "Find a name for something you already have in mind.", icon: "names" },
  { value: "visual_identity_only", label: "Visual identity", description: "Give an existing name a considered visual world.", icon: "layers" },
];

export const briefExamples = [
  { id: "b2b", category: "B2B product", title: "A calmer way to manage maintenance", description: "A subscription tool for small property teams that brings maintenance requests, contractor updates, and building history into one place. It replaces scattered email threads and helps a property manager keep tenants informed. The first customers will be independent teams managing 20–100 buildings. The brand should feel dependable, clear, and easy to work with." },
  { id: "food", category: "Local food", title: "A neighborhood kitchen with a short menu", description: "A neighborhood lunch counter that cooks a small seasonal menu using ingredients from nearby growers. We will serve warm grain bowls, soup, and one changing baked dish, with food to eat in or take away. We want to become a regular stop for people who work nearby and families in the neighborhood. The feeling should be welcoming and unpretentious, with food doing most of the talking." },
  { id: "culture", category: "Public culture", title: "A place to make culture together", description: "A public cultural program that turns unused spaces into places for workshops, small exhibitions, and conversations. Local residents, artists, and community groups can propose and host activities. It should welcome people who do not normally visit galleries, with affordable events and clear information. The identity needs to work on street posters, schedules, and a simple website." },
] as const;

const segmentSchema = z.object({
  id: z.string().uuid(), name: z.string().max(180), needs: z.string().max(24011), reason: z.string().max(2000), selected: z.boolean(),
});

const localCompetitorSchema = z.object({
  id: z.uuid(), name: z.string().max(160), relevance: z.string().max(2000), url: z.string().max(2048), selected: z.boolean(),
});

const draftSchema = z.object({
  id: z.string().uuid(), title: z.string().max(160), scope: z.enum(["complete_brand", "naming_only", "visual_identity_only"]),
  description: z.string().max(12000), activity: z.string().max(2000), offering: z.string().max(2000), knownAudience: z.string().max(2000),
  suppliedName: z.string().max(180), namingNotes: z.string().max(2000), identityNotes: z.string().max(2000),
  segments: z.array(segmentSchema).max(30), stage: z.enum(["description", "review", "competitors", "audience", "personality", "positioning"]),
  // Optional fields retain compatibility with version-one drafts and account recovery copies.
  competitors: z.array(localCompetitorSchema).max(50).optional(),
  // Exact local-only review binding, including JSON escaping at the field limits.
  // The complete workspace still has its own smaller practical storage/size limits.
  competitorReviewKey: z.string().max(1_500_000).nullable().optional(),
  personality: personalitySchema.nullable().optional(),
  positioning: z.string().max(5000).optional(),
  personalityReviewedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  positioningReviewedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  // Selected audience needs can occupy most of the local store after JSON escaping.
  // Valid large drafts reach the whole-workspace quota path rather than a key parse error.
  personalityReviewKey: z.string().max(8_000_000).nullable().optional(),
  positioningReviewKey: z.string().max(8_000_000).nullable().optional(),
  conversation: conversationSchema.optional(),
  audienceConversationKey: z.string().max(64_000).nullable().optional(),
  audienceReviewedAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(), example: z.boolean(),
  // Present only when the user explicitly saves an account brief as a browser copy.
  preservedContext: contextSnapshotSchema.optional(),
  confirmedBrief: z.object({ description: z.string().max(12000), activity: z.string().max(2000), offering: z.string().max(2000), knownAudience: z.string().max(2000).default(""), conversationKey: z.string().max(64_000).optional() }).optional(),
});

const savedWorkspaceSchema = z.object({ version: z.literal(1), drafts: z.array(draftSchema).max(50) });
export type LocalDraft = z.infer<typeof draftSchema>;
export type LocalSegment = z.infer<typeof segmentSchema>;
export type LocalCompetitor = z.infer<typeof localCompetitorSchema>;
export type DraftStage = LocalDraft["stage"];

export const DRAFT_STORAGE_KEY = "fluid.local-drafts.v1";
const MAX_SERIALIZED_WORKSPACE_LENGTH = 8_000_000;
type DraftSnapshot = { loaded: boolean; drafts: LocalDraft[]; storage: "available" | "unavailable" | "invalid" };
const serverSnapshot: DraftSnapshot = { loaded: false, drafts: [], storage: "available" };
let snapshot = serverSnapshot;
let hydrated = false;
const listeners = new Set<() => void>();

function readStorage(): DraftSnapshot {
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return { loaded: true, drafts: [], storage: "available" };
    if (raw.length > MAX_SERIALIZED_WORKSPACE_LENGTH) return { loaded: true, drafts: [], storage: "invalid" };
    const parsed = savedWorkspaceSchema.safeParse(JSON.parse(raw));
    return parsed.success
      ? { loaded: true, drafts: parsed.data.drafts, storage: "available" }
      : { loaded: true, drafts: [], storage: "invalid" };
  } catch (error) {
    return { loaded: true, drafts: [], storage: error instanceof SyntaxError ? "invalid" : "unavailable" };
  }
}

function emit() { for (const listener of listeners) listener(); }
function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  snapshot = readStorage();
}
function onStorage(event: StorageEvent) {
  if (event.key !== DRAFT_STORAGE_KEY && event.key !== null) return;
  snapshot = readStorage();
  emit();
}
function subscribe(listener: () => void) {
  hydrate();
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}
function commit(drafts: LocalDraft[]) {
  hydrate();
  const validated = savedWorkspaceSchema.parse({ version: 1, drafts });
  let storage: DraftSnapshot["storage"] = "available";
  try {
    const serialized = JSON.stringify(validated);
    if (serialized.length > MAX_SERIALIZED_WORKSPACE_LENGTH) storage = "unavailable";
    else window.localStorage.setItem(DRAFT_STORAGE_KEY, serialized);
  }
  catch { storage = "unavailable"; }
  snapshot = { loaded: true, drafts: validated.drafts, storage };
  emit();
  return storage === "available";
}

export function useLocalDrafts() {
  return useSyncExternalStore(subscribe, () => snapshot, () => serverSnapshot);
}

export function localDraftStorageState() {
  hydrate();
  return snapshot.storage;
}

/** Capture the current browser copy, including tab-only changes, without sharing mutable state. */
export function getLocalDraft(id: string): LocalDraft | undefined {
  hydrate();
  const draft = snapshot.drafts.find((item) => item.id === id);
  return draft ? structuredClone(draft) : undefined;
}

export function createLocalDraft(input: Pick<LocalDraft, "title" | "scope" | "description" | "suppliedName" | "namingNotes" | "identityNotes" | "example">) {
  hydrate();
  if (snapshot.drafts.length >= 50) return null;
  const now = new Date().toISOString();
  const draft: LocalDraft = { ...input, id: crypto.randomUUID(), activity: "", offering: "", knownAudience: "", segments: [], stage: "competitors", conversation: initialConversation(input.description, now), audienceReviewedAt: null, audienceConversationKey: null, createdAt: now, updatedAt: now };
  commit([draft, ...snapshot.drafts]);
  return draft.id;
}

export function updateLocalDraft(id: string, patch: Partial<Omit<LocalDraft, "id" | "createdAt" | "updatedAt">>) {
  hydrate();
  return commit(snapshot.drafts.map((draft) => draft.id === id ? { ...draft, ...patch, updatedAt: new Date().toISOString() } : draft));
}

export function deleteLocalDraft(id: string) { return commit(snapshot.drafts.filter((draft) => draft.id !== id)); }
export function copyToLocalDraft(draft: LocalDraft) {
  hydrate();
  if (snapshot.drafts.length >= 50) return null;
  const now = new Date().toISOString();
  const copy = { ...draft, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
  const persisted = commit([copy, ...snapshot.drafts]);
  return { id: copy.id, persisted };
}
export function clearLocalDrafts() { return commit([]); }
export function scopeLabel(scope: ProjectScope) { return scopeDetails.find((item) => item.value === scope)?.label ?? "Brand"; }
export function draftTitle(draft: LocalDraft) { return draft.title.trim() || "Untitled brand"; }
