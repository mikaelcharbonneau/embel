import { inspirationCatalog, type InspirationChoice } from "@/domain/inspiration";
import type { LogoType } from "@/domain/logo-workspace";

const hues = [
  { tag: "blue", name: "Electric blue", hex: "#2454DB" },
  { tag: "red", name: "Signal red", hex: "#CF3438" },
  { tag: "green", name: "Deep green", hex: "#17624D" },
  { tag: "pink", name: "Rose", hex: "#A83F73" },
  { tag: "orange", name: "Burnt orange", hex: "#A84A19" },
  { tag: "purple", name: "Violet", hex: "#6943BC" },
];
export function contrastRatio(a: string, b: string) {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + .05) / (dark! + .05);
}
/** A repeatable design proposal from acknowledged choices, never sampled brand colors or AI output. */
export function brandBoardDirection(choices: readonly InspirationChoice[], logoType: LogoType) {
  const references = inspirationCatalog.flatMap(design => {
    const choice = choices.find(item => item.referenceId === design.id);
    return choice && (choice.ensemble || choice.elements.length) ? [{ design, choice }] : [];
  });
  const scores = hues.map(hue => ({ ...hue, score: references.reduce((sum, { design, choice }) => sum + (design.tags.includes(hue.tag) && (choice.ensemble || choice.elements.includes("colors")) ? choice.elements.includes("colors") ? 2 : 1 : 0), 0) })).sort((a, b) => b.score - a.score);
  const primary = scores[0]!.score ? scores[0]! : { name: "Ink", hex: "#191919", tag: "neutral", score: 0 };
  const accent = scores.find(hue => hue.score > 0 && hue.tag !== primary.tag) ?? { name: "Soft stone", hex: "#D9D6CB" };
  const boldReferences = references.some(({ design, choice }) => (choice.ensemble || choice.elements.includes("typography")) && design.tags.includes("bold"));
  const expressive = boldReferences || logoType === "abstract" || logoType === "pictorial" || logoType === "emblem";
  return {
    references: references.map(({ design }) => design), primary, accent,
    palette: [
      { name: primary.name, hex: primary.hex, role: "Primary · buttons & key surfaces", foreground: "#FFFFFF" },
      { name: accent.name, hex: accent.hex, role: "Accent · graphic highlights", foreground: contrastRatio(accent.hex, "#FFFFFF") >= 4.5 ? "#FFFFFF" : "#191919" },
      { name: "Ink", hex: "#191919", role: "Text · headings & body", foreground: "#FFFFFF" },
      { name: "Warm paper", hex: "#F5F3EC", role: "Background · quiet surfaces", foreground: "#191919" },
      { name: "White", hex: "#FFFFFF", role: "Surface · logo clear space", foreground: "#191919" },
    ],
    type: { family: "Geist Sans", headingWeight: expressive ? 700 : 600, tracking: expressive ? "-0.045em" : "-0.03em", rationale: expressive ? boldReferences ? "Bold typography in your saved inspiration informs a compact, confident sans serif hierarchy around your selected logo." : "A bold, compact sans serif balances the character of your selected mark." : "Clean, open letterforms support your selected logo without imitating its custom lettering." },
    rationale: primary.score ? `${/^[aeiou]/i.test(primary.name) ? "An" : "A"} ${primary.name.toLowerCase()} lead with ${accent.name.toLowerCase()} accents translates the color qualities in your saved inspiration into an original palette.` : "A restrained neutral system lets your selected logo lead. Choose color inspiration to develop a more expressive palette.",
  };
}
