"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { IconButton } from "@/components/ui/button";
import type { StepReply } from "@/features/logo-creation/model/step-reply";

/**
 * What the reply box offers for the step on screen (design decision 2: Send is the one way forward). A step puts its
 * chosen options or results in the reply box as chips; Send with nothing typed then starts its work or moves to the
 * next step. While Embel works, Stop takes Send's place.
 */
export type WorkspaceReplyChip = string | { label: string; onRemove?: () => void };
export type WorkspaceReplyAction = {
  /** Chosen options or results, shown as chips in the reply box, in the order shown ("Logo: Concept 1"). A chip
   * with `onRemove` carries a remove button (a logo type taken back before the concepts are drawn). */
  chips?: readonly WorkspaceReplyChip[];
  /** The text area's placeholder for this step. */
  placeholder?: string;
  /** Send's accessible name and tooltip when nothing is typed: the work it starts or the step it opens
   * ("Draw six concepts", "Continue to Creative direction"). */
  label?: string;
  /** Called when Send is pressed with nothing typed. Without it, Send needs typed text. */
  onSend?: () => void;
  /** Typed text for this step ("describe a change"). Without it, typed text is a message to Embel. When it resolves
   * true, the text was taken and the reply box clears it (unless it was changed meanwhile). */
  onSendText?: (text: string) => void | Promise<boolean>;
  /** Why Send cannot start the work (no credits): Send is aria-disabled and described by this. */
  blockedReason?: string;
  /** Embel is working: Stop replaces Send. */
  working?: { label: string; onStop?: () => void; stopping?: boolean };
};

function chipAt(action: WorkspaceReplyAction | null, index: number) {
  const chip = action?.chips?.[index];
  return typeof chip === "object" ? chip : null;
}
const chipLabel = (chip: WorkspaceReplyChip) => (typeof chip === "string" ? chip : chip.label);

/** The Logo and Creative direction steps render with `reply="external"` and report their reply box (`StepReply`);
 * this turns it into what the reply box shows. */
export function stepReplyAction(reply: StepReply): WorkspaceReplyAction {
  const usable = reply.canSend && !reply.outOfCredits;
  return {
    chips: reply.chips.map((chip) => ({ label: chip.label, onRemove: chip.onRemove })),
    placeholder: reply.placeholder,
    label: reply.sendLabel,
    onSend: usable ? () => reply.send("") : undefined,
    onSendText: reply.acceptsText && usable ? (text) => reply.send(text) : undefined,
    blockedReason: reply.outOfCredits ? "No credits left for this step." : undefined,
    working: reply.working ? { label: reply.stopLabel ?? "Stop", onStop: reply.stop } : undefined,
  };
}

type Registration = {
  owner: symbol;
  action: WorkspaceReplyAction;
  key: string;
  /** Fallbacks apply only when no step and no conversation action is registered. */
  fallback: boolean;
};
type Unregister = { owner: symbol; key: null };
const ReplyRegistryContext = createContext<((registration: Registration | Unregister) => void) | null>(null);

/** What decides whether the reply box must re-render: the visible state, not the handlers. */
function actionKey(action: WorkspaceReplyAction | null) {
  if (!action) return "null";
  return JSON.stringify([
    (action.chips ?? []).map((chip) => (typeof chip === "string" ? chip : [chip.label, Boolean(chip.onRemove)])),
    action.placeholder ?? null,
    action.label ?? null,
    Boolean(action.onSend),
    Boolean(action.onSendText),
    action.blockedReason ?? null,
    action.working ? [action.working.label, Boolean(action.working.onStop), Boolean(action.working.stopping)] : null,
  ]);
}

/**
 * Registers what the reply box does for this step while the calling component is mounted. Steps rendered in the
 * Workspace's work area (names, logo concepts, creative directions) call it with their chips, Send and Stop. The
 * latest registration with an action wins; unmounting or passing null removes it. Handlers are always called in
 * their latest version. `fallback` marks a default that any other registration replaces.
 */
export function useWorkspaceReply(action: WorkspaceReplyAction | null, options: { fallback?: boolean } = {}) {
  const register = useContext(ReplyRegistryContext);
  const [owner] = useState(() => Symbol("reply"));
  const latest = useRef(action);
  useEffect(() => {
    latest.current = action;
  });
  const key = actionKey(action);
  const fallback = Boolean(options.fallback);
  useEffect(() => {
    if (key === "null") {
      register?.({ owner, key: null });
      return;
    }
    // The registered action reads the latest handlers when it is used, never during rendering.
    const shape = latest.current!;
    const registered: WorkspaceReplyAction = {
      chips: shape.chips?.map((chip, index) =>
        typeof chip === "string" || !chip.onRemove
          ? chip
          : { label: chip.label, onRemove: () => chipAt(latest.current, index)?.onRemove?.() },
      ),
      placeholder: shape.placeholder,
      label: shape.label,
      blockedReason: shape.blockedReason,
      onSend: shape.onSend ? () => latest.current?.onSend?.() : undefined,
      onSendText: shape.onSendText ? (text) => latest.current?.onSendText?.(text) : undefined,
      working: shape.working && {
        label: shape.working.label,
        stopping: shape.working.stopping,
        onStop: shape.working.onStop ? () => latest.current?.working?.onStop?.() : undefined,
      },
    };
    register?.({ owner, action: registered, key, fallback });
  }, [register, owner, key, fallback]);
  useEffect(() => () => register?.({ owner, key: null }), [register, owner]);
}

/** Holds the actions registered by the steps under it, for the reply box. */
export function useReplyRegistry() {
  const [registrations, setRegistrations] = useState<readonly Registration[]>([]);
  const register = useCallback((next: Registration | Unregister) => {
    setRegistrations((previous) => {
      const index = previous.findIndex((item) => item.owner === next.owner);
      if (next.key === null) return index < 0 ? previous : previous.filter((item) => item.owner !== next.owner);
      if (index >= 0 && previous[index]!.key === next.key) return previous;
      return index >= 0 ? previous.map((item, at) => (at === index ? next : item)) : [...previous, next];
    });
  }, []);
  const step = registrations.filter((item) => !item.fallback).at(-1);
  const fallback = registrations.filter((item) => item.fallback).at(-1);
  return { action: step?.action ?? null, fallback: fallback?.action ?? null, register };
}
/** Provide `register` from useReplyRegistry to the steps rendered in the work area. */
export const WorkspaceReplyRegistry = ReplyRegistryContext;

/**
 * The reply box in the Workspace: chips for what is chosen, the text area, and one button. Send is the one primary
 * icon button; it is disabled only when there is nothing to send. While Embel works it becomes Stop in the same place.
 */
export function WorkspaceReplyBox({
  value,
  onChange,
  onSendText,
  action,
  label = "Message Embel",
  placeholder = "Reply in your own words, or ask a question…",
  readOnly = false,
  textDisabled = false,
  notice,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Typed text, when the step has no handler of its own. */
  onSendText?: (text: string) => void;
  action: WorkspaceReplyAction | null;
  label?: string;
  placeholder?: string;
  /** The text can't be changed while a message is being saved. */
  readOnly?: boolean;
  /** Typed text can't be sent right now (the reply box still moves the step forward). */
  textDisabled?: boolean;
  /** A short line under the reply box (save status). */
  notice?: ReactNode;
}) {
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const chips = action?.chips ?? [];
  const typed = value.trim();
  const working = action?.working;
  const sendText = action?.onSendText ?? onSendText;
  const canSendText = Boolean(typed && sendText && !textDisabled);
  const canSendEmpty = Boolean(!typed && action?.onSend);
  const blocked = Boolean(!typed && action?.blockedReason);
  const sendLabel = typed ? "Send prompt" : (action?.label ?? "Send prompt");
  const current = useRef({ value, onChange });
  useEffect(() => {
    current.current = { value, onChange };
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working) return;
    if (canSendText) {
      const sent = value;
      void Promise.resolve(sendText?.(sent)).then((taken) => {
        if (taken === true && current.current.value === sent) current.current.onChange("");
      });
    } else if (canSendEmpty && !blocked) action?.onSend?.();
  }

  return (
    <form ref={form} className="e-composer workspace-reply" aria-label="Reply" onSubmit={submit} noValidate>
      {chips.length > 0 && (
        <ul className="e-cluster workspace-reply__chips" aria-label="In your reply">
          {chips.map((chip, index) => (
            <li key={`${chipLabel(chip)}-${index}`}>
              <span className="e-chip e-chip--static">
                {chipLabel(chip)}
                {typeof chip === "object" && chip.onRemove && (
                  <IconButton
                    icon="x"
                    label={`Remove ${chipLabel(chip)}`}
                    size="sm"
                    tooltip={false}
                    className="workspace-reply__remove"
                    onClick={chip.onRemove}
                  />
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <label className="e-sr" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        readOnly={readOnly}
        maxLength={12000}
        rows={2}
        placeholder={action?.placeholder ?? placeholder}
        onChange={(event) => {
          if (!readOnly) onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            form.current?.requestSubmit();
          }
        }}
      />
      <div className="e-composer__actions">
        <span className="e-grow workspace-reply__notice" id={`${id}-notice`}>
          {blocked ? action?.blockedReason : notice}
        </span>
        {working ? (
          <IconButton
            key="stop"
            icon="square"
            label={working.stopping ? "Stopping…" : working.label}
            variant="primary"
            aria-disabled={!working.onStop || working.stopping || undefined}
            onClick={() => {
              if (working.onStop && !working.stopping) working.onStop();
            }}
          />
        ) : (
          <IconButton
            key="send"
            type="submit"
            icon="arrow-up"
            label={sendLabel}
            variant="primary"
            disabled={!canSendText && !canSendEmpty}
            aria-disabled={blocked || undefined}
            aria-describedby={blocked ? `${id}-notice` : undefined}
          />
        )}
      </div>
    </form>
  );
}
