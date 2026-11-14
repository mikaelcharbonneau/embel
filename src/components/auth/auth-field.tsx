import type { ReactNode } from "react";
import { InlineMessage } from "@/components/ui/message";

/**
 * The design system's text-field frame (`e-field`, `e-input`) around an input the auth forms own. The forms keep
 * their uncontrolled inputs so credentials never enter React state; this only draws the label, an optional link
 * beside it, a hint and the field's own error.
 */
export function AuthField({
  id,
  label,
  aside,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  /** A link on the label's line, such as "Forgot password?". */
  aside?: ReactNode;
  /** Shown under the field until an error replaces it. */
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  const labelElement = (
    <label className="e-field__label" htmlFor={id}>
      {label}
    </label>
  );
  return (
    <div className="e-field">
      {aside ? (
        <div className="auth-field__label-row">
          {labelElement}
          {aside}
        </div>
      ) : (
        labelElement
      )}
      <div className="e-input">{children}</div>
      {error ? (
        <InlineMessage id={`${id}-error`} tone="danger" form="field">
          {error}
        </InlineMessage>
      ) : hint ? (
        <p className="e-field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Links an input to its hint or error and marks it invalid, matching what AuthField draws. */
export function fieldDescription(
  id: string,
  { error, invalid, hint }: { error?: string; invalid?: boolean; hint?: boolean },
) {
  return {
    "aria-invalid": error || invalid ? true : undefined,
    "aria-describedby": error ? `${id}-error` : hint ? `${id}-hint` : undefined,
  } as const;
}
