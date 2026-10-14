import { competitorSchema, competitorWebsiteSchema, contextSnapshotSchema, createProjectInputSchema, intakeDetailsSchema, personalitySchema, type ContextSnapshot, type Personality } from "@/domain/projects";
import type { AccountProject } from "@/domain/project-api";
import { conversationUserContext, conversationWidgets, validateConversation, type ConversationEvent, type ConversationWidget } from "@/domain/conversation";
import { draftTitle, type LocalCompetitor, type LocalDraft } from "./local-drafts";

type CompetitorBrief = Pick<LocalDraft, "description" | "activity" | "offering" | "knownAudience" | "competitors" | "preservedContext" | "conversation">;
type ConversationDraft = Pick<LocalDraft, "conversation" | "preservedContext">;

function storedConversation(draft: ConversationDraft, saved = draft.preservedContext) {
  return draft.conversation ?? saved?.intake.conversation;
}

export function conversationContextKey(draft: ConversationDraft, saved = draft.preservedContext): string {
  return JSON.stringify(conversationUserContext(storedConversation(draft, saved)));
}

function conversationalBasis(draft: ConversationDraft, saved = draft.preservedContext) {
  const messages = conversationUserContext(storedConversation(draft, saved));
  // Do not change exact review keys already stored before conversations existed.
  return messages.length ? { messages } : {};
}

export function conversationDraftFields(context: ContextSnapshot): Pick<LocalDraft, "conversation" | "audienceConversationKey"> {
  return {
    ...(context.intake.conversation !== undefined ? { conversation: structuredClone(context.intake.conversation) } : {}),
    audienceConversationKey: context.intake.audienceReviewedAt ? conversationContextKey({ conversation: context.intake.conversation }) : null,
  };
}

/** Legacy facts are labeled saved context, never relabeled as an actual exchange. */
export function draftConversation(draft: LocalDraft): ConversationEvent[] {
  const existing = storedConversation(draft);
  if (existing !== undefined) return existing;
  let reached = Math.max(0, conversationWidgets.indexOf(draft.stage as ConversationWidget));
  if (draft.segments.length || draft.audienceReviewedAt) reached = Math.max(reached, 1);
  if (draftPersonality(draft)) reached = Math.max(reached, 2);
  if (draftPositioning(draft).trim()) reached = Math.max(reached, 3);
  return validateConversation([
    ...(draft.description.trim() ? [{ id: "saved-context", kind: "saved_context" as const, text: draft.description }] : []),
    ...conversationWidgets.slice(0, reached + 1).map((widget) => ({ id: `saved-widget-${widget}`, kind: "widget" as const, widget })),
  ]);
}

export function conversationPromptPatch(draft: LocalDraft, text: string, now = new Date().toISOString()): Partial<LocalDraft> {
  const conversation = validateConversation([...draftConversation(draft), { id: crypto.randomUUID(), kind: "user_message", text, createdAt: now }]);
  return {
    conversation, confirmedBrief: undefined, competitorReviewKey: null, audienceReviewedAt: null, audienceConversationKey: null,
    personalityReviewedAt: null, personalityReviewKey: null, positioningReviewedAt: null, positioningReviewKey: null,
  };
}

export function conversationWidgetPatch(draft: LocalDraft, widget: ConversationWidget, now = new Date().toISOString()): Partial<LocalDraft> {
  const conversation = [...draftConversation(draft)];
  for (const next of conversationWidgets.slice(0, conversationWidgets.indexOf(widget) + 1)) {
    if (!conversation.some((event) => event.kind === "widget" && event.widget === next)) conversation.push({ id: crypto.randomUUID(), kind: "widget", widget: next, createdAt: now });
  }
  return { conversation: validateConversation(conversation), stage: widget };
}

export function isAudienceReviewComplete(draft: Pick<LocalDraft, "audienceReviewedAt" | "audienceConversationKey" | "conversation" | "preservedContext">, saved = draft.preservedContext): boolean {
  if (!draft.audienceReviewedAt || !intakeDetailsSchema.shape.audienceReviewedAt.safeParse(draft.audienceReviewedAt).success) return false;
  const key = conversationContextKey(draft, saved);
  if (draft.audienceConversationKey !== undefined) return draft.audienceConversationKey === key;
  // Old browser drafts had no conversational source context to approve.
  return key === conversationContextKey({ conversation: saved?.intake.conversation });
}

function editableCompetitors(context: ContextSnapshot): LocalCompetitor[] {
  return context.competitors.map((item) => ({ id: item.id, name: item.name, relevance: item.relevance, url: item.url ?? "", selected: item.selected }));
}

/** Missing is a legacy draft; an explicitly empty list means the user removed the entries. */
export function draftCompetitors(draft: Pick<LocalDraft, "competitors" | "preservedContext">, saved = draft.preservedContext): LocalCompetitor[] {
  return draft.competitors ?? (saved ? editableCompetitors(saved) : []);
}

/** Exact content binding, not an authorization token. Never included in an account request. */
export function competitorReviewKey(draft: CompetitorBrief, saved = draft.preservedContext): string {
  return JSON.stringify({
    description: draft.description.trim(), activity: draft.activity.trim(), offering: draft.offering.trim(), knownAudience: draft.knownAudience.trim(),
    ...conversationalBasis(draft, saved),
    competitors: draftCompetitors(draft, saved).map((item) => ({ id: item.id, name: item.name.trim(), relevance: item.relevance.trim(), url: item.url.trim(), selected: item.selected })),
  });
}

export function competitorDraftFields(context: ContextSnapshot): Pick<LocalDraft, "competitors" | "competitorReviewKey"> {
  const competitors = editableCompetitors(context);
  return { competitors, competitorReviewKey: context.competitorReviewComplete ? competitorReviewKey({ ...context, competitors, conversation: context.intake.conversation }) : null };
}

export function competitorReviewValidationMessage(draft: Pick<LocalDraft, "competitors" | "preservedContext">, saved = draft.preservedContext): string | null {
  const competitors = draftCompetitors(draft, saved);
  if (competitors.length > 50) return "Keep up to 50 competitors in this brief.";
  if (new Set(competitors.map((item) => item.id)).size !== competitors.length) return "Each competitor needs a unique entry. Remove the duplicate before finishing.";
  for (const item of competitors) {
    if (item.selected && (!item.name.trim() || !item.relevance.trim())) return "Add a name and relevance reason for every retained competitor.";
    if (item.url.trim() && !competitorWebsiteSchema.safeParse(item.url.trim()).success) return "Use a complete http:// or https:// competitor website without login details, or leave it empty.";
    if (!competitorSchema.safeParse({ ...item, name: item.name.trim() || "Unfinished entry", url: item.url.trim() || undefined, origin: "user", sources: [] }).success) return "Check competitor details: names can have 160 characters, relevance 2,000, and websites 2,048.";
  }
  return null;
}

export function isCompetitorReviewComplete(draft: CompetitorBrief & Pick<LocalDraft, "competitorReviewKey">, saved = draft.preservedContext): boolean {
  if (competitorReviewValidationMessage(draft, saved)) return false;
  const current = competitorReviewKey(draft, saved);
  if (draft.competitorReviewKey !== undefined) return draft.competitorReviewKey === current;
  // Legacy recovery/promotion copies can retain a completed review only while unchanged.
  return Boolean(saved?.competitorReviewComplete && current === competitorReviewKey({ ...saved, competitors: editableCompetitors(saved), conversation: saved.intake.conversation }));
}

type StrategyBrief = CompetitorBrief & Pick<LocalDraft, "segments" | "personality" | "positioning">;
type StrategyFields = Pick<LocalDraft, "personality" | "positioning" | "personalityReviewedAt" | "positioningReviewedAt" | "personalityReviewKey" | "positioningReviewKey">;
type StrategyReviewDraft = StrategyBrief & StrategyFields;

export function draftPersonality(draft: Pick<LocalDraft, "personality" | "preservedContext">, saved = draft.preservedContext): Personality | null {
  return draft.personality !== undefined ? draft.personality : saved?.personality ?? null;
}

export function draftPositioning(draft: Pick<LocalDraft, "positioning" | "preservedContext">, saved = draft.preservedContext): string {
  return draft.positioning !== undefined ? draft.positioning : saved?.positioning ?? "";
}

function strategyBasis(draft: StrategyBrief, saved = draft.preservedContext) {
  const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return {
    description: draft.description.trim(), activity: draft.activity.trim(), offering: draft.offering.trim(), knownAudience: draft.knownAudience.trim(),
    ...conversationalBasis(draft, saved),
    competitors: draftCompetitors(draft, saved).filter((item) => item.selected).map((item) => ({ id: item.id, name: item.name.trim(), relevance: item.relevance.trim(), url: item.url.trim() })).sort(byId),
    audience: draft.segments.filter((item) => item.selected).map((item) => ({ id: item.id, name: item.name.trim(), needs: item.needs.trim(), reason: item.reason.trim() })).sort(byId),
  };
}

function personalityValues(draft: StrategyBrief, saved = draft.preservedContext) {
  const value = draftPersonality(draft, saved);
  return value ? { sincerity: value.sincerity, excitement: value.excitement, competence: value.competence, sophistication: value.sophistication, ruggedness: value.ruggedness } : null;
}

/** Exact local-only comparisons; selection order and review timestamps are not source content. */
export function personalityReviewKey(draft: StrategyBrief, saved = draft.preservedContext): string {
  return JSON.stringify({ ...strategyBasis(draft, saved), personality: personalityValues(draft, saved) });
}

export function positioningReviewKey(draft: StrategyBrief, saved = draft.preservedContext): string {
  return JSON.stringify({ ...strategyBasis(draft, saved), personality: personalityValues(draft, saved), positioning: draftPositioning(draft, saved).trim() });
}

function strategyBasisDraft(context: ContextSnapshot): StrategyBrief {
  return {
    description: context.description, activity: context.activity, offering: context.offering, knownAudience: context.knownAudience,
    competitors: editableCompetitors(context),
    segments: context.audienceSegments.map((item) => ({ id: item.id, name: item.label, needs: item.needs.join("\n"), reason: item.reason, selected: item.selected })),
    personality: context.personality, positioning: context.positioning,
    conversation: context.intake.conversation,
  };
}

export function strategyDraftFields(context: ContextSnapshot): StrategyFields {
  const basis = strategyBasisDraft(context);
  return {
    personality: context.personality ? { ...context.personality } : null, positioning: context.positioning,
    personalityReviewedAt: context.intake.personalityReviewedAt, positioningReviewedAt: context.intake.positioningReviewedAt,
    personalityReviewKey: context.intake.personalityReviewedAt ? personalityReviewKey(basis) : null,
    positioningReviewKey: context.intake.positioningReviewedAt ? positioningReviewKey(basis) : null,
  };
}

export function personalityReviewValidationMessage(draft: Pick<LocalDraft, "personality" | "preservedContext">, saved = draft.preservedContext): string | null {
  const value = draftPersonality(draft, saved);
  if (!value) return "Set a personality profile before finishing the review.";
  return personalitySchema.safeParse(value).success ? null : "Set each personality dimension to a whole number from 0 to 100.";
}

function strategyReviewedAt(draft: StrategyFields, key: "personalityReviewedAt" | "positioningReviewedAt", saved?: ContextSnapshot) {
  return draft[key] !== undefined ? draft[key] : saved?.intake[key] ?? null;
}

export function isPersonalityReviewComplete(draft: StrategyReviewDraft, saved = draft.preservedContext): boolean {
  if (personalityReviewValidationMessage(draft, saved)) return false;
  const at = strategyReviewedAt(draft, "personalityReviewedAt", saved);
  if (!at || !intakeDetailsSchema.shape.personalityReviewedAt.safeParse(at).success) return false;
  const key = personalityReviewKey(draft, saved);
  if (draft.personalityReviewKey !== undefined) return draft.personalityReviewKey === key;
  return Boolean(saved?.intake.personalityReviewedAt && key === personalityReviewKey(strategyBasisDraft(saved)));
}

export function positioningReviewValidationMessage(draft: StrategyReviewDraft, saved = draft.preservedContext): string | null {
  const value = draftPositioning(draft, saved).trim();
  if (!value) return "Write a positioning statement before finishing the review.";
  if (value.length > 5000) return "Keep the positioning statement within 5,000 characters.";
  if (!isPersonalityReviewComplete(draft, saved)) return "Review the current personality before finishing positioning.";
  return null;
}

export function isPositioningReviewComplete(draft: StrategyReviewDraft, saved = draft.preservedContext): boolean {
  if (positioningReviewValidationMessage(draft, saved)) return false;
  const at = strategyReviewedAt(draft, "positioningReviewedAt", saved);
  if (!at || !intakeDetailsSchema.shape.positioningReviewedAt.safeParse(at).success) return false;
  const key = positioningReviewKey(draft, saved);
  if (draft.positioningReviewKey !== undefined) return draft.positioningReviewKey === key;
  return Boolean(saved?.intake.positioningReviewedAt && key === positioningReviewKey(strategyBasisDraft(saved)));
}

export function accountProjectDraft(project: AccountProject): LocalDraft {
  const context = project.context;
  return {
    id: project.id, title: project.title, scope: project.scope,
    description: context.description, activity: context.activity, offering: context.offering, knownAudience: context.knownAudience,
    suppliedName: context.intake.suppliedName, namingNotes: context.intake.namingNotes, identityNotes: context.intake.identityNotes,
    segments: context.audienceSegments.map((segment) => ({ id: segment.id, name: segment.label, needs: segment.needs.join("\n"), reason: segment.reason, selected: segment.selected })),
    ...competitorDraftFields(context),
    ...strategyDraftFields(context),
    ...conversationDraftFields(context),
    stage: context.intake.step, audienceReviewedAt: context.intake.audienceReviewedAt, example: context.intake.example,
    createdAt: project.created_at, updatedAt: project.created_at,
    ...(context.reformulationConfirmed ? { confirmedBrief: { description: context.description, activity: context.activity, offering: context.offering, knownAudience: context.knownAudience } } : {}),
  };
}

/** Patch the visible intake onto the saved snapshot; keep downstream decisions and provenance. */
export function draftContext(draft: LocalDraft, saved = draft.preservedContext): ContextSnapshot {
  const base = saved ?? contextSnapshotSchema.parse({});
  const briefKeys = ["description", "activity", "offering", "knownAudience"] as const;
  const briefChanged = briefKeys.some((key) => draft[key].trim() !== base[key]);
  const conversationChanged = conversationContextKey(draft, saved) !== conversationContextKey({ conversation: base.intake.conversation });
  const reviewed = draft.confirmedBrief && briefKeys.every((key) => draft.confirmedBrief?.[key].trim() === draft[key].trim()) &&
    (draft.confirmedBrief.conversationKey === undefined ? !conversationChanged : draft.confirmedBrief.conversationKey === conversationContextKey(draft, saved));
  const conversation = storedConversation(draft, saved);
  return contextSnapshotSchema.parse({
    ...base,
    description: draft.description, activity: draft.activity, offering: draft.offering, knownAudience: draft.knownAudience,
    // Keep the editable name consistent for account-generated names as well as
    // standalone imports. Original provenance remains in its immutable source.
    ...(draft.suppliedName.trim() !== base.intake.suppliedName.trim() ? { selectedName: draft.suppliedName.trim() || null } : {}),
    reformulationConfirmed: Boolean(draft.activity.trim() && draft.offering.trim()) && (Boolean(reviewed) || (!conversationChanged && (saved ? !briefChanged && base.reformulationConfirmed : !draft.confirmedBrief && (draft.stage === "audience" || draft.stage === "competitors")))),
    competitorReviewComplete: isCompetitorReviewComplete(draft, saved),
    personality: draftPersonality(draft, saved), positioning: draftPositioning(draft, saved),
    competitors: draftCompetitors(draft, saved).map((item) => {
      const previous = base.competitors.find((entry) => entry.id === item.id);
      const url = item.url.trim() || undefined;
      const changed = previous && (item.name.trim() !== previous.name || item.relevance.trim() !== previous.relevance || url !== previous.url);
      return {
        id: item.id, name: item.name, relevance: item.relevance, ...(url ? { url } : {}), selected: item.selected,
        // Historical citations remain available; manual corrections are not fresh research.
        origin: changed ? "user" : previous?.origin ?? "user", sources: previous?.sources ?? [],
      };
    }),
    intake: {
      ...(base.intake.guidedInterview ? { guidedInterview: base.intake.guidedInterview } : {}),
      suppliedName: draft.suppliedName.trim(), namingNotes: draft.namingNotes, identityNotes: draft.identityNotes, step: draft.stage, audienceReviewedAt: isAudienceReviewComplete(draft, saved) ? draft.audienceReviewedAt : null, example: draft.example,
      ...(conversation !== undefined ? { conversation } : {}),
      personalityReviewedAt: isPersonalityReviewComplete(draft, saved) ? strategyReviewedAt(draft, "personalityReviewedAt", saved) : null,
      positioningReviewedAt: isPositioningReviewComplete(draft, saved) ? strategyReviewedAt(draft, "positioningReviewedAt", saved) : null,
    },
    audienceSegments: draft.segments.map((segment) => {
      const previous = base.audienceSegments.find((item) => item.id === segment.id);
      return {
        ...previous, id: segment.id, label: segment.name, reason: segment.reason, selected: segment.selected,
        needs: previous && segment.needs === previous.needs.join("\n") ? previous.needs : segment.needs.split("\n").map((need) => need.trim()).filter(Boolean),
        origin: previous?.origin ?? "user", sources: previous?.sources ?? [],
      };
    }),
  });
}

export function createAccountInput(draft: LocalDraft) {
  return createProjectInputSchema.parse({ title: draftTitle(draft), scope: draft.scope, context: draftContext(draft) });
}

export function draftValidationMessage(draft: LocalDraft) {
  if (draft.segments.some((segment) => !segment.name.trim())) return "Give each audience a name before saving to your account.";
  if (draftCompetitors(draft).some((item) => !item.name.trim())) return "Give each competitor a name or remove the unfinished entry before saving to your account.";
  const competitorError = competitorReviewValidationMessage(draft);
  if (competitorError) return competitorError;
  return "Check the length of your brief and audience details. Each audience can have up to 12 needs of 2,000 characters each, one per line.";
}
