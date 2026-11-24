"use client";
import { useMemo } from "react";
import { createBrowserVoiceAdapter } from "./browser-voice-adapter";
import { unavailableHomeVoiceAdapter, type BrowserSpeechEnvironment } from "./voice-contract";

/** Dictation for a prompt or reply box: the browser's speech recognition, in the browser's language
 * (as its own dictation does). Nothing of the browser's speech system is touched until a press. */
export function useBrowserVoice() {
  const adapter = useMemo(
    () =>
      typeof window === "undefined"
        ? unavailableHomeVoiceAdapter
        : createBrowserVoiceAdapter(window as unknown as BrowserSpeechEnvironment),
    [],
  );
  const language = useMemo(() => (typeof navigator === "undefined" ? "" : navigator.language) || "en-US", []);
  return { adapter, language };
}
