"use client";

import {
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { IconButton } from "./button";
import { Icon } from "./icon";
import { InlineMessage } from "./message";

type FieldFrame = {
  label: ReactNode;
  /** Shown under the label; an example or a rule, never the only instruction. */
  hint?: ReactNode;
  /** Shown under the field with an icon; also sets aria-invalid. */
  error?: ReactNode;
  /** Marks the field "Optional" beside its label. */
  optional?: boolean;
  /** Visually hides the label (it stays the accessible name). Use only where a heading already names the field. */
  hideLabel?: boolean;
  className?: string;
};

/** Label, hint, control and error, linked for assistive technology. */
function Frame({
  id,
  label,
  hint,
  error,
  optional,
  hideLabel,
  className,
  children,
}: FieldFrame & { id: string; children: (described: string | undefined) => ReactNode }) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const described = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className ? `e-field ${className}` : "e-field"}>
      <label className={hideLabel ? "e-field__label e-sr" : "e-field__label"} htmlFor={id}>
        {label}
        {optional ? <span className="e-field__optional"> Optional</span> : null}
      </label>
      {hint ? (
        <p className="e-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {children(described)}
      {error ? (
        <InlineMessage id={errorId} tone="danger" form="field">
          {error}
        </InlineMessage>
      ) : null}
    </div>
  );
}

export type TextFieldProps = FieldFrame &
  Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
    /** Search shows a leading icon; password gets a show/hide toggle. */
    type?: "text" | "email" | "password" | "search" | "number" | "url" | "tel";
  };

/** A single-line input with its label, hint and error. */
export function TextField({
  label,
  hint,
  error,
  optional,
  hideLabel,
  className,
  id,
  type = "text",
  ...input
}: TextFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const [shown, setShown] = useState(false);
  return (
    <Frame id={fieldId} {...{ label, hint, error, optional, hideLabel, className }}>
      {(described) => (
        <div className="e-input">
          {type === "search" ? <Icon name="search" size="sm" muted /> : null}
          <input
            {...input}
            id={fieldId}
            type={type === "password" && shown ? "text" : type}
            aria-invalid={error ? true : input["aria-invalid"]}
            aria-describedby={[described, input["aria-describedby"]].filter(Boolean).join(" ") || undefined}
          />
          {type === "password" ? (
            <IconButton
              icon={shown ? "eye-off" : "eye"}
              label={shown ? "Hide password" : "Show password"}
              size="sm"
              pressed={shown}
              tooltip={false}
              onClick={() => setShown((value) => !value)}
            />
          ) : null}
        </div>
      )}
    </Frame>
  );
}

export type TextAreaFieldProps = FieldFrame & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className">;

export function TextAreaField({
  label,
  hint,
  error,
  optional,
  hideLabel,
  className,
  id,
  ...textarea
}: TextAreaFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <Frame id={fieldId} {...{ label, hint, error, optional, hideLabel, className }}>
      {(described) => (
        <div className="e-input e-input--textarea">
          <textarea
            {...textarea}
            id={fieldId}
            aria-invalid={error ? true : textarea["aria-invalid"]}
            aria-describedby={[described, textarea["aria-describedby"]].filter(Boolean).join(" ") || undefined}
          />
        </div>
      )}
    </Frame>
  );
}

export type SelectFieldProps = FieldFrame &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> & { children: ReactNode };

/** The browser's own select, drawn as a field with the system's chevron. */
export function SelectField({
  label,
  hint,
  error,
  optional,
  hideLabel,
  className,
  id,
  children,
  ...select
}: SelectFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <Frame id={fieldId} {...{ label, hint, error, optional, hideLabel, className }}>
      {(described) => (
        <div className="e-input e-select">
          <select
            {...select}
            id={fieldId}
            aria-invalid={error ? true : select["aria-invalid"]}
            aria-describedby={[described, select["aria-describedby"]].filter(Boolean).join(" ") || undefined}
          >
            {children}
          </select>
          <Icon name="chevron-down" size="sm" />
        </div>
      )}
    </Frame>
  );
}
