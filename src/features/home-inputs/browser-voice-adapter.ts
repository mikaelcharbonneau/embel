import {
  HomeVoiceError,
  type HomeVoiceAdapter,
  type BrowserSpeechEnvironment,
  type BrowserSpeechEventMap,
  type VoiceAvailability,
  type VoiceErrorCode,
} from "./voice-contract";
const UNSUPPORTED = "Dictation isn’t supported in this browser. You can still type your prompt.";
function deadline<T>(operation: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new HomeVoiceError("cancelled"));
      return;
    }
    const abort = () => settle(() => reject(new HomeVoiceError("cancelled")));
    const timer = setTimeout(() => settle(() => reject(new HomeVoiceError("start_timeout"))), ms);
    let finished = false;
    const settle = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      fn();
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}
/** Dictation through the browser's own speech recognition (`SpeechRecognition`, or Safari's and older
 * Chromium's `webkitSpeechRecognition`). Speech is turned into text on the device when the browser says it
 * can do that for the language; otherwise the browser uses its own speech service, as its built-in
 * dictation does. Embel never records, uploads or stores audio, and no AI provider is called. */
export function createBrowserVoiceAdapter(browser: BrowserSpeechEnvironment): HomeVoiceAdapter {
  const Recognition = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
  const supported = (language: string) =>
    Boolean(browser.isSecureContext && Recognition && language.trim() && language.length <= 64);
  /** Only whether the browser has speech recognition. Nothing of it is touched before the person presses
   * the button: asking a browser about on-device speech at page load is not free (it crashed the
   * headless Chromium that CI uses). */
  async function availability(language: string, signal: AbortSignal): Promise<VoiceAvailability> {
    return supported(language) && !signal.aborted
      ? { status: "available", language }
      : { status: "unavailable", reason: UNSUPPORTED };
  }
  /** At the press: can this browser turn this language into text on the device itself? */
  async function onDeviceMode(language: string, signal: AbortSignal): Promise<boolean> {
    try {
      return Boolean(
        Recognition?.available &&
        "processLocally" in new Recognition() &&
        (await deadline(Recognition.available({ langs: [language], processLocally: true }), signal, 3_000)) ===
          "available",
      );
    } catch {
      // The browser could not say; its ordinary recognition is used.
      return false;
    }
  }
  return {
    availability,
    async start(input) {
      if (!supported(input.language) || !Recognition || input.signal.aborted) {
        const code = input.signal.aborted ? "cancelled" : "unsupported";
        input.onError(code);
        throw new HomeVoiceError(code);
      }
      const onDevice = await onDeviceMode(input.language, input.signal);
      if (input.signal.aborted) throw new HomeVoiceError("cancelled");
      const disclosure = onDevice
        ? "Your speech is turned into text on this device."
        : "Your browser turns your speech into text and may send the audio to its speech service.";
      const recognition = new Recognition();
      if (onDevice) {
        recognition.processLocally = true;
        // The person was told the audio stays on the device; never fall back silently.
        if (recognition.processLocally !== true) {
          input.onError("unsupported");
          throw new HomeVoiceError("unsupported");
        }
      }
      recognition.lang = input.language;
      recognition.interimResults = true;
      // Keeps listening across pauses until the person stops it.
      recognition.continuous = true;
      return new Promise<{ stop(): Promise<void>; disclosure: string }>((resolve, reject) => {
        let active = true,
          started = false,
          ended = false,
          stopping: Promise<void> | null = null;
        let stopResolve: (() => void) | undefined,
          stopReject: ((error: Error) => void) | undefined,
          stopTimer: ReturnType<typeof setTimeout> | undefined;
        const segments = new Map<number, { text: string; final: boolean }>();
        function cleanup() {
          clearTimeout(startTimer);
          clearTimeout(stopTimer);
          input.signal.removeEventListener("abort", onAbort);
          recognition.removeEventListener("start", onStart);
          recognition.removeEventListener("end", onEnd);
          recognition.removeEventListener("error", onError);
          recognition.removeEventListener("result", onResult);
        }
        function fail(code: VoiceErrorCode) {
          if (!active) return;
          active = false;
          cleanup();
          try {
            recognition.abort();
          } catch {
            /* Unconfirmed transport has already been fenced. */
          }
          input.onError(code);
          const error = new HomeVoiceError(code);
          if (!started) reject(error);
          stopReject?.(error);
        }
        function onAbort() {
          fail("cancelled");
        }
        function onStart() {
          if (!active || started || input.signal.aborted) return;
          started = true;
          clearTimeout(startTimer);
          resolve({
            disclosure,
            stop() {
              if (ended) return Promise.resolve();
              if (stopping) return stopping;
              if (!active) return Promise.reject(new HomeVoiceError("stop_unconfirmed"));
              stopping = new Promise<void>((done, rejected) => {
                stopResolve = done;
                stopReject = rejected;
              });
              stopTimer = setTimeout(() => fail("stop_unconfirmed"), 5_000);
              try {
                recognition.stop();
              } catch {
                fail("stop_unconfirmed");
              }
              return stopping;
            },
          });
        }
        function onEnd() {
          if (!active) return;
          if (!started) {
            fail("transport");
            return;
          }
          active = false;
          ended = true;
          cleanup();
          stopResolve?.();
          input.onEnd();
        }
        function onError(event: BrowserSpeechEventMap["error"]) {
          fail(
            event.error === "not-allowed" || event.error === "service-not-allowed"
              ? "permission_denied"
              : event.error === "no-speech"
                ? "no_speech"
                : event.error === "aborted"
                  ? "cancelled"
                  : event.error === "language-not-supported"
                    ? "unsupported"
                    : "transport",
          );
        }
        function onResult(event: BrowserSpeechEventMap["result"]) {
          if (!active || !started || input.signal.aborted) return;
          if (!Number.isInteger(event.resultIndex) || event.resultIndex < 0 || event.results.length > 256) {
            fail("transport");
            return;
          }
          for (let index = event.resultIndex; index < event.results.length; index++) {
            const result = event.results[index],
              text = result?.[0]?.transcript;
            if (!result || typeof text !== "string" || text.length > 12_000) {
              fail("transport");
              return;
            }
            segments.set(index, { text, final: result.isFinal });
          }
          for (const index of segments.keys()) if (index >= event.results.length) segments.delete(index);
          const values = [...segments].sort(([a], [b]) => a - b).map(([, value]) => value);
          // Settled words are the leading run of final segments; everything after may still change.
          const settled = values.findIndex((value) => !value.final),
            split = settled === -1 ? values.length : settled;
          const join = (part: typeof values) =>
            part
              .map((value) => value.text.trim())
              .filter(Boolean)
              .join(" ");
          const finalText = join(values.slice(0, split)),
            interimText = join(values.slice(split));
          if (finalText.length + interimText.length > 12_000) {
            fail("transport");
            return;
          }
          input.onTranscript({ finalText, interimText });
        }
        const startTimer = setTimeout(() => fail("start_timeout"), 15_000);
        recognition.addEventListener("start", onStart);
        recognition.addEventListener("end", onEnd);
        recognition.addEventListener("error", onError);
        recognition.addEventListener("result", onResult);
        input.signal.addEventListener("abort", onAbort, { once: true });
        if (input.signal.aborted) {
          fail("cancelled");
          return;
        }
        try {
          recognition.start();
        } catch {
          fail("transport");
        }
      });
    },
  };
}
