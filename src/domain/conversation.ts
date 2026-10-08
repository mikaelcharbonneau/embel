import { z } from "zod";

export const MAX_CONVERSATION_EVENTS = 64;
export const MAX_PROMPT_LENGTH = 12_000;
export const MAX_CONVERSATION_BYTES = 64_000;
export const conversationWidgets = ["competitors", "audience", "personality", "positioning"] as const;
export const conversationWidgetSchema = z.enum(conversationWidgets);
export type ConversationWidget = z.infer<typeof conversationWidgetSchema>;
const eventId = z.string().min(1).max(128);
const promptText = z.string().max(MAX_PROMPT_LENGTH).refine((value) => Boolean(value.trim()), { message: "Write a message before sending." });

// Provider messages are read from verified, owner-scoped job results, never client-authored intake.
export const conversationEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ id: eventId, kind: z.literal("user_message"), text: promptText, createdAt: z.iso.datetime({ offset: true }) }),
  z.strictObject({ id: eventId, kind: z.literal("saved_context"), text: promptText }),
  z.strictObject({ id: eventId, kind: z.literal("widget"), widget: conversationWidgetSchema, createdAt: z.iso.datetime({ offset: true }).optional() }),
]);
export type ConversationEvent = z.infer<typeof conversationEventSchema>;

export const conversationSchema = z.array(conversationEventSchema).max(MAX_CONVERSATION_EVENTS).superRefine((events, ctx) => {
  if (new Set(events.map((event) => event.id)).size !== events.length) ctx.addIssue({ code: "custom", message: "Each conversation event needs a unique identifier." });
  const widgets = events.filter((event) => event.kind === "widget").map((event) => event.widget);
  if (new Set(widgets).size !== widgets.length) ctx.addIssue({ code: "custom", message: "Each strategy widget appears once in the conversation." });
  if (widgets.some((widget, index) => widget !== conversationWidgets[index])) ctx.addIssue({ code: "custom", message: "Keep strategy widgets in order: competitors, audience, personality, positioning." });
  if (events.filter((event) => event.kind === "saved_context").length > 1) ctx.addIssue({ code: "custom", message: "A conversation has one preserved-context entry." });
  if (new TextEncoder().encode(JSON.stringify(events)).byteLength > MAX_CONVERSATION_BYTES) ctx.addIssue({ code: "custom", message: "This conversation reached its 64 KB limit. Keep the existing messages and shorten the new one." });
});

export function validateConversation(events: ConversationEvent[]): ConversationEvent[] {
  const result = conversationSchema.safeParse(events);
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Check this conversation before saving it.");
  return result.data;
}

export function initialConversation(text: string, now: string): ConversationEvent[] {
  return validateConversation([
    { id: crypto.randomUUID(), kind: "user_message", text, createdAt: now },
    { id: crypto.randomUUID(), kind: "widget", widget: "competitors", createdAt: now },
  ]);
}

/** Only actual user messages change the conversational source context. */
export function conversationUserContext(events: readonly ConversationEvent[] | undefined) {
  return (events ?? []).filter((event) => event.kind === "user_message").map((event) => ({ id: event.id, text: event.text }));
}
