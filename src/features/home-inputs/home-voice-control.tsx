"use client";
import { useEffect, useRef } from "react";
import { IconButton } from "@/components/ui/button";
import type { HomeVoiceAdapter, VoiceErrorCode } from "./voice-contract";
import { useHomeVoice } from "./use-home-voice";
type HomeVoiceControlProps = {
  value: string;
  onChange(value: string): void;
  language: string;
  sessionFence: string;
  adapter: HomeVoiceAdapter;
  disabled: boolean;
};
/** The prompt with dictated words added at its end, or null when they would not fit. */
export function appendDictation(value: string, text: string): string | null {
  const added = text.trim();
  if (!added) return value;
  const result = `${value}${value && !/\s$/u.test(value) ? " " : ""}${added}`;
  return result.length <= 12_000 ? result : null;
}
const errors: Record<VoiceErrorCode, string> = {
  permission_denied:
    "Microphone access is blocked. Allow the microphone for this site in your browser, then try again.",
  unsupported: "Dictation isn’t supported in this browser. You can still type your prompt.",
  no_speech: "Nothing was heard. Try again, or keep typing.",
  cancelled: "",
  transport: "Dictation stopped unexpectedly. What was added to your prompt is kept.",
  start_timeout: "The microphone didn’t start. Try again.",
  stop_unconfirmed: "Dictation was stopped.",
  too_long: "Your prompt has reached 12,000 characters, so dictation stopped.",
};
/** The microphone button of the prompt box. One press starts dictation and the words appear in the prompt
 * as they are spoken; a second press stops it. */
export function HomeVoiceControl({
  value,
  onChange,
  language,
  sessionFence,
  adapter,
  disabled,
}: HomeVoiceControlProps) {
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  });
  const voice = useHomeVoice({
    adapter,
    language,
    sessionFence,
    onText(text) {
      const next = appendDictation(latest.current, text);
      if (next === null) return false;
      latest.current = next;
      onChange(next);
      return true;
    },
  });
  const capturing = voice.state === "starting" || voice.state === "listening" || voice.state === "stopping";
  const { discard } = voice;
  useEffect(() => {
    // A held prompt (a send under way, another account's text) takes no more dictated words.
    if (disabled && capturing) discard();
  }, [disabled, capturing, discard]);
  const message = voice.error
    ? voice.error === "unsupported" && voice.availability?.status === "unavailable"
      ? voice.availability.reason
      : errors[voice.error]
    : "";
  return (
    <>
      <IconButton
        className="home-voice-button"
        icon={capturing ? "square" : "mic"}
        label="Dictate your prompt"
        pressed={capturing}
        tooltip={false}
        title={capturing ? "Stop dictation" : "Dictate your prompt"}
        disabled={disabled || voice.state === "stopping"}
        onClick={() => {
          if (voice.state === "listening") void voice.stop();
          else if (voice.state === "starting") discard();
          else void voice.start();
        }}
      />
      {capturing && (
        <p className="home-input-note home-voice-status" role="status">
          <span className="home-voice-dot" aria-hidden="true" />
          {voice.state === "starting" ? (
            "Waiting for your microphone…"
          ) : (
            <>
              Listening… <span className="home-voice-interim">{voice.transcript}</span>
              {voice.availability?.status === "available" && (
                <span className="home-voice-disclosure">{voice.availability.disclosure}</span>
              )}
            </>
          )}
        </p>
      )}
      {message && (
        <p className="home-input-note form-error" role="alert">
          {message}
        </p>
      )}
    </>
  );
}
