import {
  HomeVoiceError,
  type HomeVoiceAdapter,
  type OnDeviceSpeechEnvironment,
  type OnDeviceSpeechEventMap,
  type VoiceAvailability,
  type VoiceErrorCode,
} from "./voice-contract";
const DISCLOSURE = "Voice is transcribed on this device. Review the text before adding it to your prompt.";
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
/** Native local-only path. No prefixed recognition, provider, recording upload or install fallback. */
export function createOnDeviceVoiceAdapter(browser: OnDeviceSpeechEnvironment): HomeVoiceAdapter {
  async function availability(language: string, signal: AbortSignal): Promise<VoiceAvailability> {
    const unavailable = (reason: string): VoiceAvailability => ({ status: "unavailable", reason });
    if (
      !browser.isSecureContext ||
      !browser.SpeechRecognition?.available ||
      !language.trim() ||
      language.length > 64 ||
      signal.aborted
    )
      return unavailable("On-device voice is unavailable in this browser. Typing is still available.");
    try {
      const probe = new browser.SpeechRecognition();
      if (!("processLocally" in probe)) return unavailable("This browser cannot guarantee on-device transcription.");
      const status = await deadline(
        browser.SpeechRecognition.available({ langs: [language], processLocally: true }),
        signal,
        15_000,
      );
      if (status !== "available")
        return unavailable(
          "An installed on-device language pack is required. No download or cloud transcription will start.",
        );
      return { status: "available", language, transportId: "native-on-device", disclosure: DISCLOSURE };
    } catch {
      return unavailable("On-device speech availability could not be verified. Typing is still available.");
    }
  }
  return {
    availability,
    async start(input) {
      if ((await availability(input.language, input.signal)).status !== "available") {
        const code = input.signal.aborted ? "cancelled" : "unsupported";
        input.onError(code);
        throw new HomeVoiceError(code);
      }
      if (input.signal.aborted) throw new HomeVoiceError("cancelled");
      const recognition = new browser.SpeechRecognition!();
      recognition.processLocally = true;
      if (recognition.processLocally !== true) {
        input.onError("unsupported");
        throw new HomeVoiceError("unsupported");
      }
      recognition.lang = input.language;
      recognition.interimResults = true;
      recognition.continuous = false;
      return new Promise<{ stop(): Promise<void> }>((resolve, reject) => {
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
        function onError(event: OnDeviceSpeechEventMap["error"]) {
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
        function onResult(event: OnDeviceSpeechEventMap["result"]) {
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
          const values = [...segments].sort(([a], [b]) => a - b).map(([, value]) => value),
            text = values
              .map((value) => value.text.trim())
              .join(" ")
              .trim();
          if (text.length > 12_000) {
            fail("transport");
            return;
          }
          input.onTranscript({ text, final: values.every((value) => value.final) });
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
