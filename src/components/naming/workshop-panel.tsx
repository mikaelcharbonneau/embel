"use client";

import { useState, type FormEvent } from "react";
import { Icon } from "@/components/ui/icon";
import type { NameCandidate, NamesForm, NamesUi, NamesMutationResult } from "./local-names";
import { namesStore } from "./use-names-store";
import { transformLabels } from "./name-candidate-card";

const transforms: { kind: NamesForm["kind"]; description: string }[] = [
  { kind: "affixes", description: "Add a beginning or ending" },
  { kind: "tweaks", description: "Change case or spacing" },
  { kind: "blend", description: "Join parts of two words" },
  { kind: "swap", description: "Replace exact text" },
];
const operations: { value: NamesForm["operations"][number]; label: string }[] = [
  { value: "lowercase", label: "lowercase" }, { value: "uppercase", label: "UPPERCASE" },
  { value: "titlecase", label: "Title Case" }, { value: "remove_spaces", label: "Remove spaces" }, { value: "hyphenate", label: "Hyphenate spaces" },
];

export function ContextEditor({ ui }: { ui: NamesUi }) {
  return <details className="names-context-editor"><summary>Context for new names <span>Optional</span></summary>
    <p>Captured with each new name. Editing this brief leaves earlier results unchanged.</p>
    <label className="names-field">Brief description<textarea value={ui.context.description} maxLength={12000} rows={3} onChange={event => namesStore.updateContext({ description: event.target.value })} placeholder="What are you naming?" /></label>
    <label className="names-field">Known audience<textarea value={ui.context.knownAudience} maxLength={2000} rows={2} onChange={event => namesStore.updateContext({ knownAudience: event.target.value })} placeholder="Who is it for?" /></label>
    <label className="names-field">Naming notes<textarea value={ui.context.intake.namingNotes} maxLength={2000} rows={2} onChange={event => namesStore.updateContext({ namingNotes: event.target.value })} placeholder="A tone, a constraint, something to keep in mind" /></label>
  </details>;
}

export function WorkshopPanel({ ui, candidates, onResult }: { ui: NamesUi; candidates: NameCandidate[]; onResult: (result: NamesMutationResult, success: string) => void }) {
  const [chooseSeed, setChooseSeed] = useState(false);
  const form = ui.form;
  const parent = candidates.find(candidate => candidate.source.id === ui.seedCandidateId);
  const library = candidates.filter(candidate => candidate.saved || candidate.favorite);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onResult(namesStore.runWorkshop(), "Workshop run recorded.");
  }
  const patch = (value: Partial<NamesForm>) => namesStore.updateForm(value);
  return <aside className="names-workshop-panel" aria-label="Workshop controls">
    <form onSubmit={submit} className="names-transform-form">
      <label className="names-field">{form.kind === "blend" ? "First word" : "Start with a word"}<input id="names-seed" value={form.kind === "blend" ? form.left : form.seed} maxLength={160} required onChange={event => patch(form.kind === "blend" ? { left: event.target.value } : { seed: event.target.value })} autoComplete="off" placeholder="Your starting word" /></label>
      <button type="button" className="text-link names-library-seed" onClick={() => setChooseSeed(!chooseSeed)} aria-expanded={chooseSeed}>or choose from your library<Icon name="chevron" size={12} /></button>
      {chooseSeed ? <div className="names-seed-picker">
        {library.length ? <label className="names-field">Saved or favorite name<select value={ui.seedCandidateId ?? ""} onChange={event => { if (event.target.value) { namesStore.useAsSeed(event.target.value); setChooseSeed(false); } }}><option value="">Choose a name</option>{library.map(candidate => <option key={candidate.source.id} value={candidate.source.id}>{candidate.source.value}</option>)}</select></label> : <p>Your saved and favorite names will appear here.</p>}
      </div> : null}
      {parent ? <div className="names-seed-lineage"><Icon name="layers" size={14} /><span>Continuing <strong>{parent.source.value}</strong> · {parent.source.history.length} previous {parent.source.history.length === 1 ? "step" : "steps"}. Captured context carried forward.</span></div> : <p className="names-seed-note">Manual seed · starts a new transformation history.</p>}
      <fieldset className="names-transform-picker"><legend>Transformation</legend>{transforms.map(transform => <label className={form.kind === transform.kind ? "is-active" : ""} key={transform.kind}>
        <input type="radio" name="naming-transform" value={transform.kind} checked={form.kind === transform.kind} onChange={() => patch({ kind: transform.kind })} />
        <strong>{transformLabels[transform.kind]}</strong><span>{transform.description}</span>
      </label>)}</fieldset>
      <div className="names-transform-options">
        {form.kind === "affixes" ? <>
          <label className="names-field">Prefixes<textarea rows={2} value={form.prefixes} maxLength={2000} onChange={event => patch({ prefixes: event.target.value })} placeholder="One per line, or comma-separated" /></label>
          <label className="names-field">Suffixes<textarea rows={2} value={form.suffixes} maxLength={2000} onChange={event => patch({ suffixes: event.target.value })} placeholder="One per line, or comma-separated" /></label>
          <label className="names-field">Separator<select value={form.separator} onChange={event => patch({ separator: event.target.value as NamesForm["separator"] })}><option value="">None</option><option value=" ">Space</option><option value="-">Hyphen</option></select></label>
          <p className="names-muted">Literal prefix + seed + suffix combinations. Up to 12 entries per side; 64 unique results per run.</p>
        </> : null}
        {form.kind === "tweaks" ? <fieldset className="names-tweaks"><legend>Make one variant for each selected change</legend>{operations.map(operation => <label key={operation.value}><input type="checkbox" checked={form.operations.includes(operation.value)} onChange={event => patch({ operations: event.target.checked ? [...form.operations, operation.value] : form.operations.filter(value => value !== operation.value) })} />{operation.label}</label>)}<p className="names-muted">Each change is applied to the original seed. Unchanged and duplicate variants are omitted.</p></fieldset> : null}
        {form.kind === "blend" ? <>
          <label className="names-field">Second word<input value={form.right} maxLength={160} required onChange={event => patch({ right: event.target.value })} placeholder="Another word" /></label>
          <div className="names-number-fields"><label className="names-field">Keep from first<input inputMode="numeric" type="number" min="1" max="160" step="1" required value={form.leftTake} onChange={event => patch({ leftTake: event.target.value })} /></label><label className="names-field">Skip from second<input inputMode="numeric" type="number" min="0" max="160" step="1" required value={form.rightDrop} onChange={event => patch({ rightDrop: event.target.value })} /></label></div>
          <p className="names-muted">Keep the chosen number of characters from the start of the first word, then append the second after skipping its beginning. Combined characters and emoji stay whole.</p>
        </> : null}
        {form.kind === "swap" ? <>
          <label className="names-field">Find exact text<input value={form.find} maxLength={160} required onChange={event => patch({ find: event.target.value })} placeholder="Text to replace" /></label>
          <label className="names-field">Replace with<input value={form.replacement} maxLength={160} onChange={event => patch({ replacement: event.target.value })} placeholder="Leave blank to remove" /></label>
          <label className="names-field">Replace<select value={form.match} onChange={event => patch({ match: event.target.value as NamesForm["match"] })}><option value="all">All matches</option><option value="first">First match</option></select></label>
          <p className="names-muted">Matches are literal and case-sensitive. Spaces count as text; no pattern matching is used.</p>
        </> : null}
      </div>
      <button type="submit" className="button primary names-run-button">Run {transformLabels[form.kind]}<Icon name="arrow" size={15} /></button>
      <p className="names-local-transform"><Icon name="device" size={13} />Runs locally · no AI</p>
    </form>
    <ContextEditor ui={ui} />
  </aside>;
}
