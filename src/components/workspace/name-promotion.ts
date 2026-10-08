"use client";

import { namingSourceSchema, type NamingSource } from "@/domain/naming";
import { conversationWidgets, type ConversationWidget } from "@/domain/conversation";
import { contextSnapshotSchema, type ContextSnapshot } from "@/domain/projects";
import { copyToLocalDraft, localDraftStorageState, type LocalDraft } from "./local-drafts";
import { competitorDraftFields, conversationDraftFields, strategyDraftFields } from "./project-draft-adapter";

/** Prepare a new draft; never change the source name, its history or its captured context. */
export function brandDraftFromName(sourceInput: NamingSource, contextInput: ContextSnapshot, id: string, now: string): LocalDraft {
  const source = namingSourceSchema.parse(sourceInput);
  const original = contextSnapshotSchema.parse(contextInput);
  const stage = conversationWidgets.includes(original.intake.step as ConversationWidget)
    ? original.intake.step as ConversationWidget
    : "competitors";
  const context = contextSnapshotSchema.parse({
    ...original,
    selectedName: source.value,
    namingSource: source,
    intake: { ...original.intake, suppliedName: source.value, step: stage },
  });
  return {
    id, title: source.value, scope: "complete_brand",
    description: context.description, activity: context.activity, offering: context.offering,
    knownAudience: context.knownAudience, suppliedName: source.value,
    namingNotes: context.intake.namingNotes, identityNotes: context.intake.identityNotes,
    segments: context.audienceSegments.map((segment) => ({
      id: segment.id, name: segment.label, needs: segment.needs.join("\n"), reason: segment.reason, selected: segment.selected,
    })),
    ...competitorDraftFields(context),
    ...strategyDraftFields(context),
    ...conversationDraftFields(context),
    stage, audienceReviewedAt: context.intake.audienceReviewedAt,
    createdAt: now, updatedAt: now, example: context.intake.example,
    preservedContext: context,
    ...(context.reformulationConfirmed ? { confirmedBrief: {
      description: context.description, activity: context.activity, offering: context.offering, knownAudience: context.knownAudience,
    } } : {}),
  };
}

/** Explicit browser-copy action; the returned flag reports actual persistence. */
export function createBrandFromName(source: NamingSource, context: ContextSnapshot) {
  if (localDraftStorageState() === "invalid") {
    throw new Error("Saved brand drafts could not be read. Recover or clear them in Settings before creating a brand.");
  }
  const draft = brandDraftFromName(source, context, crypto.randomUUID(), new Date().toISOString());
  return copyToLocalDraft(draft);
}
