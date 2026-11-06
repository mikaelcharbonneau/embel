"use client";

import { useId } from "react";
import type { ProjectScope } from "@/domain/projects";

// The three validated project scopes, shown as a switch inside the Home box.
const scopes: { label: string; value: ProjectScope }[] = [
  { label: "Complete brand", value: "complete_brand" },
  { label: "Name only", value: "naming_only" },
  { label: "Visual identity", value: "visual_identity_only" },
];

/** Native radios keep arrow-key selection and form semantics; the labels are
 * styled as one segmented pill. */
export function HomeScopePicker({ value, onChange, disabled = false }: {
  value: ProjectScope; onChange(value: ProjectScope): void; disabled?: boolean;
}) {
  const name = useId();
  return <fieldset className="home-scope" disabled={disabled}>
    <legend className="sr-only">What to create</legend>
    {scopes.map(option => <label key={option.value} className="home-scope-option" data-checked={option.value === value}>
      <input className="sr-only" type="radio" name={name} value={option.value} checked={option.value === value} onChange={() => onChange(option.value)} />
      {option.label}
    </label>)}
  </fieldset>;
}
