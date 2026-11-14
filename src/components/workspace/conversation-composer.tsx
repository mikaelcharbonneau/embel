"use client";

import { useId, useLayoutEffect, useRef, type FormEvent } from "react";
import { Icon } from "@/components/ui/icon";

type ConversationComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  label: string;
  placeholder: string;
  error?: string;
  hint?: React.ReactNode;
  disabled?: boolean;
  readOnly?: boolean;
  initial?: boolean;
  home?: boolean;
  project?: boolean;
  inputControls?: React.ReactNode;
  sendLabel?: string;
};

export function ConversationComposer({
  value,
  onChange,
  onSend,
  label,
  placeholder,
  error,
  hint,
  disabled,
  readOnly = false,
  initial = false,
  home = false,
  project = false,
  inputControls,
  sendLabel = "Send prompt",
}: ConversationComposerProps) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    let width = -1;
    const resize = () => {
      if (!input.getClientRects().length) return;
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
      width = input.clientWidth;
    };
    resize();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (input.clientWidth !== width) resize();
          });
    observer?.observe(input);
    window.addEventListener("resize", resize);
    document.fonts?.addEventListener("loadingdone", resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      document.fonts?.removeEventListener("loadingdone", resize);
      input.style.removeProperty("height");
    };
  }, [home, initial, placeholder, value]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!disabled) onSend();
  }

  return (
    <form
      ref={formRef}
      className={`conversation-composer ${initial ? "is-initial" : ""} ${home ? "home-composer" : ""} ${error ? "has-error" : ""}`}
      onSubmit={submit}
      noValidate
    >
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <textarea
        ref={inputRef}
        id={id}
        name="message"
        autoComplete="off"
        value={value}
        readOnly={readOnly}
        maxLength={12000}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        aria-describedby={
          hint === null ? (error ? `${id}-error` : undefined) : `${id}-hint${error ? ` ${id}-error` : ""}`
        }
        onChange={(event) => {
          if (!readOnly) onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            if (!disabled) formRef.current?.requestSubmit();
          }
        }}
      />
      <div className="conversation-composer-footer">
        {inputControls}
        {hint !== null && (
          <span className={initial ? "sr-only" : undefined} id={`${id}-hint`}>
            {hint ?? "Shift + Enter for a new line"}
          </span>
        )}
        <button
          className={`button primary ${project || home || sendLabel === "Send prompt" ? "composer-send-icon" : ""}`}
          type="submit"
          disabled={disabled}
          title={sendLabel}
        >
          <span className={project || home || sendLabel === "Send prompt" ? "sr-only" : undefined}>{sendLabel}</span>
          {project ? <Icon name="arrow-up" size="sm" /> : <Icon name="arrow-up" size={home ? 16 : 18} />}
        </button>
      </div>
      {error && (
        <p className="form-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
