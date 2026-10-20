"use client";

import type { ContextSnapshot } from "@/domain/projects";
import type { NameTransformInput } from "@/domain/naming";
import { Icon } from "@/components/ui/icon";
import type { NameCandidate, NameRun } from "./local-names";

export const transformLabels = { affixes: "Affixes", tweaks: "Tweaks", blend: "Blend", swap: "Swap" } as const;
const tweakLabels = { lowercase: "Lowercase", uppercase: "Uppercase", titlecase: "Title Case", remove_spaces: "Remove spaces", hyphenate: "Hyphenate spaces" } as const;

export function TransformParameters({ input }: { input: NameTransformInput }) {
  return <dl className="names-parameters" aria-label="Exact transform parameters">
    <div><dt>{input.kind === "blend" ? "First word" : "Starting word"}</dt><dd>{input.kind === "blend" ? input.left : input.seed}</dd></div>
    {input.kind === "affixes" ? <><div><dt>Prefixes</dt><dd>{input.prefixes.length ? <ul>{input.prefixes.map((prefix, index) => <li key={index}>{prefix || "None"}</li>)}</ul> : "None"}</dd></div><div><dt>Suffixes</dt><dd>{input.suffixes.length ? <ul>{input.suffixes.map((suffix, index) => <li key={index}>{suffix || "None"}</li>)}</ul> : "None"}</dd></div><div><dt>Separator</dt><dd>{input.separator === " " ? "Space" : input.separator === "-" ? "Hyphen" : "None"}</dd></div></> : null}
    {input.kind === "tweaks" ? <div><dt>Changes</dt><dd><ul>{input.operations.map(operation => <li key={operation}>{tweakLabels[operation]}</li>)}</ul></dd></div> : null}
    {input.kind === "blend" ? <><div><dt>Second word</dt><dd>{input.right}</dd></div><div><dt>Keep from first</dt><dd>{input.leftTake}</dd></div><div><dt>Skip from second</dt><dd>{input.rightDrop}</dd></div></> : null}
    {input.kind === "swap" ? <><div><dt>Find exact text</dt><dd>“{input.find}”</dd></div><div><dt>Replace with</dt><dd>{input.replacement ? `“${input.replacement}”` : "Remove matched text"}</dd></div><div><dt>Replace</dt><dd>{input.match === "first" ? "First match" : "All matches"}</dd></div></> : null}
  </dl>;
}

export function NameSymbol({ name, filled = false }: { name: "favorite" | "saved" | "compare"; filled?: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "favorite" ? <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" /> : name === "saved" ? <path d="M6 3h12v18l-6-4-6 4Z" /> : <><rect x="3" y="5" width="7" height="14" rx="1" /><rect x="14" y="5" width="7" height="14" rx="1" /></>}
  </svg>;
}

export function CapturedContext({ context }: { context: ContextSnapshot }) {
  const supplied = Boolean(context.description || context.knownAudience || context.intake.namingNotes);
  return <div className="names-captured-context">
    {!supplied ? <p>No brief, audience, or naming notes supplied.</p> : <dl>
      {context.description ? <div><dt>Brief</dt><dd>{context.description}</dd></div> : null}
      {context.knownAudience ? <div><dt>Known audience</dt><dd>{context.knownAudience}</dd></div> : null}
      {context.intake.namingNotes ? <div><dt>Naming notes</dt><dd>{context.intake.namingNotes}</dd></div> : null}
    </dl>}
  </div>;
}

export function RunParameters({ run }: { run: NameRun }) {
  return <details className="names-run-details"><summary>Exact parameters &amp; captured context</summary>
    <TransformParameters input={run.input} />
    <CapturedContext context={run.context} />
  </details>;
}

export function NameCandidateCard({ candidate, compared, comparisonFull, onFavorite, onSave, onCompare, onSeed, onCreateBrand, row = false }: {
  row?: boolean; candidate: NameCandidate; compared: boolean; comparisonFull: boolean;
  onFavorite: () => void; onSave: () => void; onCompare: () => void; onSeed: () => void; onCreateBrand: () => void;
}) {
  const { source } = candidate;
  return <article className={`names-candidate${row ? " names-candidate-row" : ""}${compared ? " is-compared" : ""}`} aria-label={`Name: ${source.value}`}>
    <div className="names-candidate-title">{row && <button type="button" className="names-row-compare" aria-label={`${compared ? "Remove" : "Compare"} ${source.value}${compared ? " from comparison" : ""}`} aria-pressed={compared} disabled={!compared && comparisonFull} onClick={onCompare}><span aria-hidden="true">{compared && <Icon name="check" size={12} />}</span></button>}<h3 title={source.value}>{source.value}</h3><button type="button" className={`names-favorite${candidate.favorite ? " is-active" : ""}`} aria-label={`${candidate.favorite ? "Unfavorite" : "Favorite"} ${source.value}`} aria-pressed={candidate.favorite} onClick={onFavorite}><NameSymbol name="favorite" filled={candidate.favorite} /></button></div>
    <p className="names-candidate-origin">{source.origin === "manual" ? "Added manually" : `${transformLabels[source.history.at(-1)!.input.kind]} · ${source.history.length} ${source.history.length === 1 ? "step" : "steps"}`}</p>
    <div className="names-candidate-controls">
      <button type="button" className={`names-chip${candidate.saved ? " is-active" : ""}`} aria-label={`${candidate.saved ? "Unsave" : "Save"} ${source.value}`} aria-pressed={candidate.saved} onClick={onSave}><NameSymbol name="saved" filled={candidate.saved} />{candidate.saved ? "Saved" : "Save"}</button>
      {!row && <button type="button" className={`names-chip${compared ? " is-active" : ""}`} aria-label={`${compared ? "Remove" : "Compare"} ${source.value}${compared ? " from comparison" : ""}`} aria-pressed={compared} disabled={!compared && comparisonFull} onClick={onCompare}><NameSymbol name="compare" />{compared ? "In tray" : "Compare"}</button>}
      <button type="button" className="names-seed-action" onClick={onSeed}>Use as seed<Icon name="arrow" size={14} /></button>
    </div>
    <details className="names-candidate-details"><summary>Context &amp; history</summary>
      {row && source.value.length > 60 && <p className="names-full-value"><strong>Full name</strong>{source.value}</p>}
      <p className="names-explanation">{candidate.explanation}</p>
      <CapturedContext context={candidate.context} />
      {source.history.length ? <ol className="names-lineage">{source.history.map((step, index) => <li key={step.id}>
        <div><span>{index + 1}. {transformLabels[step.input.kind]}</span><strong>{step.output}</strong></div>
        <details><summary>Parameters</summary><TransformParameters input={step.input} /></details>
      </li>)}</ol> : <p className="names-muted">No transformations yet.</p>}
      <button type="button" className="button secondary small" onClick={onCreateBrand}>Create brand<Icon name="arrow" size={14} /></button>
      <p className="names-muted">Creates a new project in your account with this name and its captured context.</p>
    </details>
  </article>;
}
