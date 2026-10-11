"use client";

import { useId, useRef, type FormEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { ProjectArtwork } from "@/components/ui/project-artwork";

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

export function ConversationComposer({ value, onChange, onSend, label, placeholder, error, hint, disabled, readOnly = false, initial = false, home = false, project = false, inputControls, sendLabel = "Send prompt" }: ConversationComposerProps) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!disabled) onSend();
  }

  return <form ref={formRef} className={`conversation-composer ${initial ? "is-initial" : ""} ${home ? "home-composer" : ""} ${error ? "has-error" : ""}`} onSubmit={submit} noValidate>
    <label className="sr-only" htmlFor={id}>{label}</label>
    <textarea id={id} value={value} readOnly={readOnly} maxLength={12000} placeholder={placeholder} aria-invalid={Boolean(error)} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} onChange={(event) => { if (!readOnly) onChange(event.target.value); }} onKeyDown={(event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        if (!disabled) formRef.current?.requestSubmit();
      }
    }} />
    <div className="conversation-composer-footer">{inputControls}<span className={initial ? "sr-only" : undefined} id={`${id}-hint`}>{hint ?? "Shift + Enter for a new line"}</span><button className={`button primary ${(project || home || sendLabel === "Send prompt") ? "composer-send-icon" : ""}`} type="submit" disabled={disabled} title={sendLabel}><span className={(project || home || sendLabel === "Send prompt") ? "sr-only" : undefined}>{sendLabel}</span>{project ? <ProjectArtwork name="send" /> : <Icon name={home ? "arrow" : "arrow-up"} size={home ? 20 : 18} />}</button></div>
    {error && <p className="form-error" id={`${id}-error`} role="alert">{error}</p>}
  </form>;
}
