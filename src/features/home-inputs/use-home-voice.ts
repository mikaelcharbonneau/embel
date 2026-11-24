"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { HomeVoiceError, type HomeVoiceAdapter, type VoiceAvailability, type VoiceErrorCode } from "./voice-contract";
type HomeVoiceState = "idle" | "starting" | "listening" | "stopping" | "error";
type Capture = {
  controller: AbortController;
  fence: string;
  /** The settled words already handed to `onText`. */
  delivered: string;
  ended: boolean;
  handle: { stop(): Promise<void> } | null;
};
/** Live dictation. Settled words are handed to `onText` as they arrive, so the prompt stays an ordinary
 * editable text the whole time; the words still being guessed are only shown (`transcript`). `onText`
 * answers false when the words do not fit, which ends the dictation with `too_long`. */
export function useHomeVoice({
  adapter,
  language,
  sessionFence,
  onText,
}: {
  adapter: HomeVoiceAdapter;
  language: string;
  sessionFence: string;
  onText(text: string): boolean;
}) {
  const [availability, setAvailability] = useState<VoiceAvailability | null>(null);
  const [view, setView] = useState<{
    fence: string;
    state: HomeVoiceState;
    transcript: string;
    error: VoiceErrorCode | null;
  }>({ fence: sessionFence, state: "idle", transcript: "", error: null });
  const operation = useRef<Capture | null>(null),
    alive = useRef(false),
    deliver = useRef(onText);
  useEffect(() => {
    deliver.current = onText;
  });
  const discard = useCallback(() => {
    const previous = operation.current;
    operation.current = null;
    previous?.controller.abort();
    setView({ fence: sessionFence, state: "idle", transcript: "", error: null });
  }, [sessionFence]);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    const previous = operation.current;
    operation.current = null;
    previous?.controller.abort();
    const task = setTimeout(() => {
      if (controller.signal.aborted) return;
      setAvailability(null);
      setView({ fence: sessionFence, state: "idle", transcript: "", error: null });
      void adapter
        .availability(language, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setAvailability(value);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setAvailability({
              status: "unavailable",
              reason: "Dictation isn’t supported in this browser. You can still type your prompt.",
            });
        });
    }, 0);
    return () => {
      alive.current = false;
      clearTimeout(task);
      controller.abort();
      const previous = operation.current;
      operation.current = null;
      previous?.controller.abort();
    };
  }, [adapter, language, sessionFence]);
  async function start() {
    if (!alive.current || operation.current) return;
    if (availability?.status !== "available") {
      // Asked before the browser answered, or in a browser without speech recognition: say so.
      if (availability) setView({ fence: sessionFence, state: "error", transcript: "", error: "unsupported" });
      return;
    }
    const current: Capture = {
      controller: new AbortController(),
      fence: sessionFence,
      delivered: "",
      ended: false,
      handle: null,
    };
    operation.current = current;
    const live = () => alive.current && operation.current === current && !current.controller.signal.aborted;
    setView({ fence: sessionFence, state: "starting", transcript: "", error: null });
    try {
      const handle = await adapter.start({
        language,
        signal: current.controller.signal,
        onTranscript(event) {
          if (!live() || current.ended) return;
          // Only words added after what was already delivered; a browser that rewrites settled words is ignored.
          if (event.finalText.length > current.delivered.length && event.finalText.startsWith(current.delivered)) {
            const added = event.finalText.slice(current.delivered.length).trim();
            current.delivered = event.finalText;
            if (added && !deliver.current(added)) {
              current.ended = true;
              operation.current = null;
              current.controller.abort();
              setView({ fence: sessionFence, state: "error", transcript: "", error: "too_long" });
              return;
            }
          }
          setView((previous) => ({ ...previous, transcript: event.interimText }));
        },
        onError(error) {
          if (!live()) return;
          current.ended = true;
          operation.current = null;
          current.controller.abort();
          // A pause after words were already added is the ordinary end of a dictation, not a failure.
          setView(
            error === "no_speech" && current.delivered
              ? { fence: sessionFence, state: "idle", transcript: "", error: null }
              : { fence: sessionFence, state: "error", transcript: "", error },
          );
        },
        onEnd() {
          if (!live()) return;
          current.ended = true;
          operation.current = null;
          setView({ fence: sessionFence, state: "idle", transcript: "", error: null });
        },
      });
      if (!live()) {
        void handle.stop().catch(() => undefined);
        return;
      }
      current.handle = handle;
      if (!current.ended) setView((previous) => ({ ...previous, state: "listening" }));
    } catch (error) {
      if (!live()) return;
      operation.current = null;
      current.controller.abort();
      setView({
        fence: sessionFence,
        state: "error",
        transcript: "",
        error: error instanceof HomeVoiceError ? error.code : "transport",
      });
    }
  }
  async function stop() {
    const current = operation.current;
    if (!current || !current.handle || current.ended || current.controller.signal.aborted) return;
    setView((previous) => ({ ...previous, state: "stopping" }));
    try {
      await current.handle.stop();
    } catch (error) {
      if (alive.current && operation.current === current) {
        operation.current = null;
        current.controller.abort();
        setView({
          fence: sessionFence,
          state: "error",
          transcript: "",
          error: error instanceof HomeVoiceError ? error.code : "stop_unconfirmed",
        });
      }
    }
  }
  const visible = view.fence === sessionFence ? view : { state: "idle" as const, transcript: "", error: null };
  return {
    availability,
    ...visible,
    start,
    stop,
    discard,
  };
}
