"use client";

import { useId, useState, type FormEvent } from "react";
import { nameTransformInputSchema, type NameTransformInput } from "@/domain/naming";
import { Icon } from "@/components/ui/icon";

export type WorkshopControlsValue = {
  kind: NameTransformInput["kind"];
  prefixes: string;
  suffixes: string;
  separator: "" | " " | "-";
  operations: Extract<NameTransformInput, { kind: "tweaks" }>["operations"];
  right: string;
  secondaryCandidateId: string;
  leftTake: string;
  rightDrop: string;
  find: string;
  replacement: string;
  match: "all" | "first";
};

export function initialWorkshopControls(): WorkshopControlsValue {
  return { kind: "affixes", prefixes: "", suffixes: "", separator: "", operations: ["lowercase"], right: "", secondaryCandidateId: "", leftTake: "1", rightDrop: "0", find: "", replacement: "", match: "all" };
}

/** Presentation input only. The caller chooses the seed, persistence and replay boundary. */
export function workshopControlsInput(seed: string, value: WorkshopControlsValue): NameTransformInput {
  const entries = (text: string) => text.split(/[,\n]/u).map(entry => entry.trim()).filter(Boolean);
  switch (value.kind) {
    case "affixes": return nameTransformInputSchema.parse({ kind: value.kind, seed, prefixes: entries(value.prefixes), suffixes: entries(value.suffixes), separator: value.separator });
    case "tweaks": return nameTransformInputSchema.parse({ kind: value.kind, seed, operations: value.operations });
    case "blend": return nameTransformInputSchema.parse({ kind: value.kind, left: seed, right: value.right, leftTake: Number(value.leftTake), rightDrop: Number(value.rightDrop) });
    case "swap": return nameTransformInputSchema.parse({ kind: value.kind, seed, find: value.find, replacement: value.replacement, match: value.match });
  }
}

const kinds = [
  { kind: "affixes", label: "Affixes", detail: "Add a beginning or ending" },
  { kind: "tweaks", label: "Tweaks", detail: "Change case or spacing" },
  { kind: "blend", label: "Blend", detail: "Join parts of two names" },
  { kind: "swap", label: "Swap", detail: "Replace exact text" },
] as const;
const operations = [
  { value: "lowercase", label: "lowercase" }, { value: "uppercase", label: "UPPERCASE" },
  { value: "titlecase", label: "Title Case" }, { value: "remove_spaces", label: "Remove spaces" }, { value: "hyphenate", label: "Hyphenate spaces" },
] as const;

export function WorkshopControls({ seed, value, onChange, onRun, disabled = false, secondaryOptions }: {
  seed: string;
  value: WorkshopControlsValue;
  onChange: (next: WorkshopControlsValue) => void;
  onRun: (input: NameTransformInput, secondaryCandidateId?: string) => void;
  disabled?: boolean;
  secondaryOptions?: ReadonlyArray<{ id: string; value: string; label?: string }>;
}) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  function patch(next: Partial<WorkshopControlsValue>) { onChange({ ...value, ...next }); setError(null); }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    try {
      const secondary = value.kind === "blend" && secondaryOptions ? secondaryOptions.find(option => option.id === value.secondaryCandidateId) : undefined;
      if (value.kind === "blend" && secondaryOptions && !secondary) { setError("Choose a saved project name to preserve its transformation history."); return; }
      const input = workshopControlsInput(seed, secondary ? { ...value, right: secondary.value } : value);
      setError(null); onRun(input, secondary?.id);
    }
    catch { setError("Review these controls. Use up to 12 affixes per side, choose a change, and keep character counts within the selected names."); }
  }
  return <form className="project-naming-workshop-controls" onSubmit={submit}>
    <div className="project-naming-seed"><span>Start with</span><strong>{seed}</strong></div>
    <fieldset disabled={disabled} className="project-naming-transform-kinds"><legend>Transformation</legend>{kinds.map(kind => <label key={kind.kind} className={value.kind === kind.kind ? "is-active" : ""}>
      <input type="radio" name={`${id}-transform`} value={kind.kind} checked={value.kind === kind.kind} onChange={() => patch({ kind: kind.kind })} /><strong>{kind.label}</strong><span>{kind.detail}</span>
    </label>)}</fieldset>
    <fieldset disabled={disabled} className="project-naming-control-fields"><legend className="sr-only">Transformation controls</legend>
      {value.kind === "affixes" ? <>
        <label>Prefixes<textarea value={value.prefixes} rows={2} maxLength={2000} onChange={event => patch({ prefixes: event.target.value })} placeholder="One per line, or comma-separated" /></label>
        <label>Suffixes<textarea value={value.suffixes} rows={2} maxLength={2000} onChange={event => patch({ suffixes: event.target.value })} placeholder="One per line, or comma-separated" /></label>
        <label>Separator<select value={value.separator} onChange={event => patch({ separator: event.target.value as WorkshopControlsValue["separator"] })}><option value="">None</option><option value=" ">Space</option><option value="-">Hyphen</option></select></label>
        <p>Up to 12 prefixes and 12 suffixes; 64 unique results per run.</p>
      </> : null}
      {value.kind === "tweaks" ? <div className="project-naming-checks">{operations.map(operation => <label key={operation.value}><input type="checkbox" checked={value.operations.includes(operation.value)} onChange={event => patch({ operations: event.target.checked ? [...value.operations, operation.value] : value.operations.filter(item => item !== operation.value) })} />{operation.label}</label>)}<p>Each change starts from the selected name. Unchanged results are omitted.</p></div> : null}
      {value.kind === "blend" ? <>
        {secondaryOptions ? <label>Second name<select value={value.secondaryCandidateId} required onChange={event => patch({ secondaryCandidateId: event.target.value })}><option value="">Choose a project name</option>{secondaryOptions.map(option => <option key={option.id} value={option.id}>{option.label ?? option.value}</option>)}</select></label> : <label>Second name<input value={value.right} required maxLength={160} onChange={event => patch({ right: event.target.value })} autoComplete="off" /></label>}
        <div className="project-naming-lengths"><label>Keep from first<input type="number" min={1} max={160} step={1} required value={value.leftTake} onChange={event => patch({ leftTake: event.target.value })} /></label><label>Skip from second<input type="number" min={0} max={160} step={1} required value={value.rightDrop} onChange={event => patch({ rightDrop: event.target.value })} /></label></div>
        <p>Combined characters and emoji stay whole.</p>
      </> : null}
      {value.kind === "swap" ? <>
        <label>Find exact text<input value={value.find} required maxLength={160} onChange={event => patch({ find: event.target.value })} /></label>
        <label>Replace with<input value={value.replacement} maxLength={160} onChange={event => patch({ replacement: event.target.value })} placeholder="Leave blank to remove" /></label>
        <label>Replace<select value={value.match} onChange={event => patch({ match: event.target.value as WorkshopControlsValue["match"] })}><option value="all">All matches</option><option value="first">First match</option></select></label><p>Literal, case-sensitive matches. Spaces count as text.</p>
      </> : null}
    </fieldset>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <button className="button primary" type="submit" disabled={disabled}>Run {kinds.find(kind => kind.kind === value.kind)?.label}<Icon name="arrow" size={15} /></button>
    <p className="project-naming-muted">Deterministic text transformations · no AI or availability checks</p>
  </form>;
}
