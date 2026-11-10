import type { IdentitySystemVersion, IdentityTypography } from "@/domain/project-identity";

export type VisualDirectionDescription = {
  id: string;
  title: string;
  summary: string;
  swatches: { name: string; hex: string }[];
  sampleStyle: IdentityTypography["styles"][number] | null;
};

const layouts = {
  editorial: ["Editorial", "an editorial grid"],
  centered: ["Centered", "a centered layout"],
  split: ["Split", "two side-by-side panels"],
} as const;

const graphics = {
  fine_lines: ["Linework", "Fine rules organize"],
  rounded_shapes: ["Soft Shapes", "Rounded forms soften"],
  bold_blocks: ["Blocks", "Bold blocks anchor"],
  none: ["Composition", ""],
} as const;

function shortName(value: string | undefined) {
  return value && value.length <= 40 ? value : undefined;
}

/** New specifications put display copy at the start of the composition. The
 * sentence-ending period may sit inside or outside the quoted title. */
function readDirectionCopy(text: string) {
  const prefix = text
    .trimStart()
    .match(
      /^the direction is called\s+(?:“([^”\n]{1,65})”|"([^"\n]{1,65})"|‘([^\n]{1,65}?)’|'([^\n]{1,65}?)'|«([^»\n]{1,65})»)(?=[.!?。！？\s]|$)/iu,
    );
  if (!prefix) return null;
  const quoted = prefix.slice(1).find(Boolean)?.trim() ?? "";
  let tail = text.trimStart().slice(prefix[0].length).trimStart();
  let title = quoted;
  if (/^[.!?。！？]/u.test(tail)) tail = tail.slice(1).trimStart();
  else if (/[.!?。！？]$/u.test(quoted)) title = quoted.replace(/[.。]$/u, "").trimEnd();
  else return null;
  if (!/[\p{L}\p{N}]/u.test(title) || title.length > 64) return null;
  const sentence = tail.match(/^(.+?[.!?。！？](?:[”’"»])?)(?=\s|$)/u)?.[1]?.trim();
  const summary = sentence && sentence.length <= 180 && /[\p{L}\p{N}]/u.test(sentence) ? sentence : null;
  return { title, summary };
}

function conceptTitle(system: IdentitySystemVersion, primaryName?: string) {
  const { composition, graphics: graphicDirection, imagery } = system.components;
  // A specification often contrasts this board with an earlier one. Only use
  // its positive descriptions when choosing a name for the current direction.
  const cues = [composition.direction, graphicDirection.direction, imagery.direction]
    .flatMap((text) =>
      text
        .split(/[.!?;]+/u)
        .map(
          (sentence) =>
            sentence.split(
              /\b(?:avoid|not|rather than|instead of|unlike|without|replaces?|previous|earlier|prior)\b/iu,
            )[0],
        ),
    )
    .join(" ");
  const named = cues.match(
    /\b(?:direction|concept|board|identity)\s+(?:(?:is|was)\s+)?(?:called|titled|named)\s+(?:“([^”\n]{1,64})”|"([^"\n]{1,64})"|‘([^’\n]{1,64})’)/iu,
  );
  const explicitTitle = named
    ?.slice(1)
    .find((value) => value?.trim())
    ?.trim();
  if (explicitTitle) return explicitTitle;
  const everyday = /\beveryday\b/iu.test(cues);
  if (/\bfield[-\s]guide\b/iu.test(cues)) return everyday ? "Everyday Field Guide" : "Field Guide";
  if (/\bhandbook\b/iu.test(cues)) {
    if (/\bpocket\b/iu.test(cues)) return "Pocket Handbook";
    if (/\bcommuter\b/iu.test(cues)) return "Commuter Handbook";
    if (/\brepair\b/iu.test(cues)) return "Repair Handbook";
    return "Handbook";
  }
  if (/\bworkshop\b/iu.test(cues) || (/\brepair\b/iu.test(cues) && /\b(?:workbench|tools|table)\b/iu.test(cues))) {
    return /\bfriendly\b/iu.test(cues) ? "Friendly Workshop" : "Workshop";
  }
  const design = system.applicationDesign;
  if (!design) return primaryName ? `${primaryName} Study` : "Visual Study";
  const subject = design.graphic === "none" ? layouts[design.layout][0] : graphics[design.graphic][0];
  return primaryName && !/^(?:primary|accent|background|text)(?: color)?$/iu.test(primaryName)
    ? `${primaryName} ${subject}`
    : `${layouts[design.layout][0]} ${graphics[design.graphic][0]}`;
}

function describe(system: IdentitySystemVersion): VisualDirectionDescription {
  const { colors, typography, composition } = system.components;
  const design = system.applicationDesign;
  const roles = ["primary", "accent", "background", "text"] as const;
  const roleColors = design
    ? roles.map((role) => colors.swatches.find((color) => color.key === design.paletteRoles[role]))
    : [];
  const [primary] = roleColors;
  const swatches = [...new Set([...roleColors, ...colors.swatches])].flatMap((color) =>
    color ? [{ name: color.name, hex: color.hex }] : [],
  );
  const headingStyle =
    (design
      ? typography.styles.find((style) => style.key === design.headingStyleKey)
      : typography.styles.find((style) => /\b(?:headings?|headlines?|titles?)\b/iu.test(style.role))) ?? null;
  const sampleStyle = headingStyle ?? typography.styles[0] ?? null;
  const copy = readDirectionCopy(composition.direction);
  const title = copy?.title ?? conceptTitle(system, shortName((primary ?? colors.swatches[0])?.name));
  const fallback = copy ? system.components.graphics.direction : composition.direction;
  const sentence = fallback.split(/(?<=[.!?])\s+/u)[0] ?? "";
  let summary =
    sentence.length > 180
      ? `${sentence
          .slice(0, 179)
          .replace(/\s+\S*$/u, "")
          .trimEnd()}…`
      : sentence;
  if (design) {
    const layout = layouts[design.layout][1];
    const graphic = graphics[design.graphic][1];
    const composition = graphic ? `${graphic} ${layout}` : layout[0]!.toUpperCase() + layout.slice(1);
    const color = shortName(primary?.name);
    summary = `${composition}${color ? ` in ${color}` : ""}.`;
  }
  return { id: system.id, title, summary: copy?.summary ?? summary, swatches, sampleStyle };
}

/** Describe the displayed batch in its own order, including older saved boards. */
export function describeVisualDirections(systems: readonly IdentitySystemVersion[]): VisualDirectionDescription[] {
  const boards = systems.map(describe);
  let titles = boards.map((board) => board.title);
  for (const details of [
    boards.map((board) => shortName(board.swatches[0]?.name)),
    boards.map((board) => shortName(board.sampleStyle?.family)),
  ]) {
    titles = titles.map((title, index) => {
      const detail = details[index];
      const distinguishes = titles.some((other, peer) => other === title && details[peer] !== detail);
      return detail && distinguishes && !title.includes(detail) ? `${title} · ${detail}` : title;
    });
  }
  return boards.map((board, index) => {
    const title = titles[index]!;
    return { ...board, title: titles.indexOf(title) === titles.lastIndexOf(title) ? title : `${title} · ${index + 1}` };
  });
}
