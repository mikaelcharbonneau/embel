"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { HomeVoiceError, type HomeVoiceAdapter, type VoiceAvailability, type VoiceErrorCode } from "./voice-contract";
export type HomeVoiceState = "idle" | "starting" | "listening" | "stopping" | "review" | "error";
type Capture = {
  controller: AbortController;
  fence: string;
  text: string;
  ended: boolean;
  handle: { stop(): Promise<void> } | null;
};
export function useHomeVoice({
  adapter,
  language,
  sessionFence,
}: {
  adapter: HomeVoiceAdapter;
  language: string;
  sessionFence: string;
}) {
  const [availability, setAvailability] = useState<VoiceAvailability | null>(null);
  const [view, setView] = useState<{
    fence: string;
    state: HomeVoiceState;
    transcript: string;
    error: VoiceErrorCode | null;
  }>({ fence: sessionFence, state: "idle", transcript: "", error: null });
  const operation = useRef<Capture | null>(null),
    alive = useRef(false);
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
              reason: "On-device voice could not be verified. You can still type.",
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
    if (!alive.current || operation.current || availability?.status !== "available") return;
    const current: Capture = {
      controller: new AbortController(),
      fence: sessionFence,
      text: "",
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
          current.text = event.text;
          setView((previous) => ({ ...previous, transcript: event.text }));
        },
        onError(error) {
          if (!live()) return;
          current.ended = true;
          operation.current = null;
          current.controller.abort();
          setView({ fence: sessionFence, state: "error", transcript: "", error });
        },
        onEnd() {
          if (!live()) return;
          current.ended = true;
          if (!current.text.trim()) operation.current = null;
          setView({
            fence: sessionFence,
            state: current.text.trim() ? "review" : "idle",
            transcript: current.text,
            error: null,
          });
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
    editTranscript(text: string) {
      if (visible.state === "review" && text.length <= 12_000)
        setView((previous) => ({ ...previous, transcript: text }));
    },
  };
}
