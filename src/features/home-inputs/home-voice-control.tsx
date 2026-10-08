"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { HomeVoiceAdapter, VoiceErrorCode } from "./voice-contract";
import { useHomeVoice } from "./use-home-voice";
export type HomeVoiceControlProps = { value: string; onChange(value: string): void; language: string; sessionFence: string; adapter: HomeVoiceAdapter; disabled: boolean };
export function appendReviewedTranscript(value: string, transcript: string): string | null {
 const reviewed = transcript.trim(); const result = reviewed ? `${value}${value ? "\n" : ""}${reviewed}` : value;
 return result.length <= 12_000 ? result : null;
}
const errors: Record<VoiceErrorCode, string> = {
 permission_denied: "Microphone access was denied. Your typed prompt is unchanged.", unsupported: "On-device voice is unavailable. Your typed prompt is unchanged.", no_speech: "No speech was detected. You can try again or keep typing.", cancelled: "Voice capture cancelled.", transport: "Voice could not finish. Your typed prompt is unchanged.", start_timeout: "Microphone start was not confirmed. Voice capture was cancelled.", stop_unconfirmed: "Voice stop could not be confirmed. Capture was cancelled and no text was added.",
};
export function HomeVoiceControl({ value, onChange, language, sessionFence, adapter, disabled }: HomeVoiceControlProps) {
 const voice = useHomeVoice({ adapter, language, sessionFence }), id = useId(), startButton = useRef<HTMLButtonElement>(null);
 const [appendError, setAppendError] = useState(false), returnFocus = useRef(false);
 useEffect(() => { if (voice.state === "idle" && returnFocus.current) { returnFocus.current = false; startButton.current?.focus(); } }, [voice.state]);
 const capturing = ["starting", "listening", "stopping"].includes(voice.state);
 function cancel() { returnFocus.current = true; voice.discard(); setAppendError(false); }
 function useTranscript() {
  if (disabled || voice.state !== "review") return;
  const result = appendReviewedTranscript(value, voice.transcript);
  if (result === null) { setAppendError(true); return; }
  onChange(result); returnFocus.current = true; voice.discard(); setAppendError(false);
 }
 return <section aria-label="On-device voice input" onKeyDown={event => { if (event.key === "Escape" && (capturing || voice.state === "review")) { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
  <button ref={startButton} className="button secondary small" type="button" disabled={disabled || voice.availability?.status !== "available" || capturing || voice.state === "review"} onClick={() => { setAppendError(false); void voice.start(); }}>Start voice input</button>
  {voice.availability?.status === "unavailable" && <p className="field-hint">{voice.availability.reason}</p>}
  {voice.availability?.status === "available" && <p className="field-hint">{voice.availability.disclosure}</p>}
  {voice.state === "starting" && <p role="status">Waiting for microphone start…</p>}
  {voice.state === "listening" && <><p role="status">Listening on this device…</p><button className="button secondary small" type="button" onClick={() => void voice.stop()}>Stop voice input</button></>}
  {voice.state === "stopping" && <p role="status">Waiting for recording to end…</p>}
  {capturing && <><p aria-live="polite">{voice.transcript}</p><button type="button" className="text-link" onClick={cancel}>Cancel voice input</button></>}
  {voice.state === "review" && <><label htmlFor={id}>Review transcript</label><textarea id={id} value={voice.transcript} maxLength={12000} onChange={event => voice.editTranscript(event.target.value)} /><button type="button" className="button secondary small" disabled={disabled || !voice.transcript.trim()} onClick={useTranscript}>Use transcript</button><button type="button" className="text-link" onClick={cancel}>Discard transcript</button></>}
  {voice.error && <p className="form-error" role="alert">{errors[voice.error]}</p>}
  {appendError && <p className="form-error" role="alert">Adding this transcript would exceed 12,000 characters. Shorten the prompt or transcript; neither was changed.</p>}
 </section>;
}
