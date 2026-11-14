import { z } from "zod";
import type { LogoType } from "./logo-vector";

/** Liked logos guide logo concepts through short style notes, written once by a
 * text model from the liked logo image: how its symbol is built and, separately,
 * its lettering. The image model never sees the liked image itself. */
export const LOGO_STYLE_NOTE_VERSION = "logo-style-note-v1" as const;
export const LOGO_STYLE_NOTE_INSTRUCTION = [
  "You are a senior brand identity designer. The image shows a logo that someone liked as inspiration for a different brand of their own.",
  "Describe only the visual design qualities a designer could carry into a new, original logo.",
  "symbol: one line of 25 to 45 words of comma-separated design phrases on how the symbol is constructed (geometry, grid, modules, repetition),",
  "stroke or line weight, corners and terminals, density and use of negative space, rhythm and balance, and level of detail. Use null when there is no symbol.",
  "lettering: one line of 8 to 20 words on the typeface category, weight, width, case and spacing of any lettering. Use null when there is no lettering.",
  "Ignore the brand name, the words, what the symbol depicts, colors, gradients, backgrounds, photos and mockup settings. No full sentences, no brand names.",
].join(" ");
/** Strict structured output for the note request. */
export const LOGO_STYLE_NOTE_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["symbol", "lettering"],
  properties: { symbol: { type: ["string", "null"] }, lettering: { type: ["string", "null"] } },
});
const noteText = (max: number) =>
  z
    .string()
    .transform((value) => value.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1).max(max))
    .nullable();
export const logoStyleNoteSchema = z.strictObject({ symbol: noteText(600), lettering: noteText(300) });
export type LogoStyleNote = z.infer<typeof logoStyleNoteSchema>;

/** Brief lines. The saved inspiration block of a logo brief starts with this heading. */
const LOGO_INSPIRATION_HEADING = /^Saved inspiration · catalog \S+ · selection (\d+):$/u;
export const LIKED_LOGO_STYLE = "Liked logo style: ";
export const LIKED_LETTERING = "Liked lettering: ";
/** Closes a block written with style notes; its presence marks the block's format. */
export const LIKED_LOGO_DIRECTION =
  "Use these liked logo styles as direction for an original logo, without copying them; the initial logo concepts remain black and white.";

const typesWithText: ReadonlySet<LogoType> = new Set<LogoType>([
  "wordmark",
  "lettermark_monogram",
  "combination",
  "emblem",
]);
/** Logo types whose concepts draw letters. The others draw a symbol alone. */
export const logoTypeDrawsText = (type: LogoType) => typesWithText.has(type);

/** The brief's personality as an image prompt should see it. In a block written
 * with style notes, only the notes and the closing direction reach the image
 * model; liked-brand descriptions stay in the saved brief for Creative
 * direction. Lettering notes reach only concepts that draw text, so a symbol is
 * never pulled toward adding a name. Lines before the block are kept as written,
 * and a brief without style notes (older, or edited by hand) is unchanged. */
export function logoPromptPersonality(personality: string, drawsText: boolean): string {
  const lines = personality.split("\n"),
    start = lines.findIndex((line) => LOGO_INSPIRATION_HEADING.test(line));
  if (start < 0 || !lines.slice(start + 1).includes(LIKED_LOGO_DIRECTION)) return personality;
  const kept = lines
    .slice(start + 1)
    .filter(
      (line) =>
        line.startsWith(LIKED_LOGO_STYLE) ||
        line === LIKED_LOGO_DIRECTION ||
        (drawsText && line.startsWith(LIKED_LETTERING)),
    );
  return [...lines.slice(0, start + 1), ...kept].join("\n");
}
