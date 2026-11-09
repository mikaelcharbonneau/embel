import { ContextDetails } from "@/components/ui/context-details";
import type { NamingSource, NameTransformInput } from "@/domain/naming";

const methodLabels = { affixes: "Affixes", tweaks: "Tweaks", blend: "Blend", swap: "Swap" } as const;
const tweakLabels = { lowercase: "lowercase", uppercase: "uppercase", titlecase: "title case", remove_spaces: "remove spaces", hyphenate: "hyphenate" } as const;

function parameters(input: NameTransformInput) {
  switch (input.kind) {
    case "affixes": return `Seed: ${input.seed}. Prefixes: ${input.prefixes.join(", ") || "none"}. Suffixes: ${input.suffixes.join(", ") || "none"}. Separator: ${input.separator === " " ? "space" : input.separator === "-" ? "hyphen" : "none"}.`;
    case "tweaks": return `Seed: ${input.seed}. Variants: ${input.operations.map((operation) => tweakLabels[operation]).join(", ")}.`;
    case "blend": return `Keep ${input.leftTake} characters from ${input.left}; join ${input.right} after dropping its first ${input.rightDrop} characters.`;
    case "swap": return `In ${input.seed}, replace ${input.match === "all" ? "every occurrence" : "the first occurrence"} of “${input.find}” with ${input.replacement ? `“${input.replacement}”` : "nothing"}.`;
  }
}

export function NameOrigin({ source }: { source: NamingSource }) {
  return <section className="name-origin-panel" aria-label="Original name and history">
    <div className="name-origin-heading"><div><span className="secondary-text">Started from Names</span><h2>{source.value}</h2></div></div>
    <p>The name and its original context were copied into this brand. Domain, handle and trademark checks have not been run.</p>
    <ContextDetails  title={<>{source.history.length ? `View ${source.history.length} transformation ${source.history.length === 1 ? "step" : "steps"}` : "View name source"}</>}>{source.origin === "manual" ? <p>This name was entered manually.</p> : <ol>{source.history.map((step) => <li key={step.id}><strong>{methodLabels[step.input.kind]} → {step.output}</strong><p>{parameters(step.input)}</p></li>)}</ol>}<p className="secondary-text">This records the original name. Later edits keep this history.</p></ContextDetails>
  </section>;
}
