export type VoiceAvailability =
  | { status: "unavailable"; reason: string }
  | { status: "available"; transportId: string; language: string; onDevice: boolean; disclosure: string };
export type VoiceErrorCode =
  | "permission_denied"
  | "unsupported"
  | "no_speech"
  | "cancelled"
  | "transport"
  | "start_timeout"
  | "stop_unconfirmed"
  | "too_long";
export interface HomeVoiceAdapter {
  availability(language: string, signal: AbortSignal): Promise<VoiceAvailability>;
  start(input: {
    language: string;
    signal: AbortSignal;
    /** `finalText` only grows: the words the browser has settled on. `interimText` is its current guess at
     * what follows and may still change. */
    onTranscript(event: { finalText: string; interimText: string }): void;
    onError(code: VoiceErrorCode): void;
    onEnd(): void;
  }): Promise<{ stop(): Promise<void> }>;
}
export type BrowserSpeechEventMap = {
  start: Event;
  end: Event;
  error: { error: string };
  result: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; [index: number]: { transcript: string } }> };
};
export interface BrowserSpeechRecognition {
  processLocally?: boolean;
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  addEventListener<K extends keyof BrowserSpeechEventMap>(
    type: K,
    listener: (event: BrowserSpeechEventMap[K]) => void,
  ): void;
  removeEventListener<K extends keyof BrowserSpeechEventMap>(
    type: K,
    listener: (event: BrowserSpeechEventMap[K]) => void,
  ): void;
}
type BrowserSpeechRecognitionClass = {
  new (): BrowserSpeechRecognition;
  /** Newer browsers can say whether a language is transcribed on the device itself. */
  available?: (options: {
    langs: string[];
    processLocally: true;
  }) => Promise<"unavailable" | "downloadable" | "downloading" | "available">;
};
export type BrowserSpeechEnvironment = {
  isSecureContext: boolean;
  SpeechRecognition?: BrowserSpeechRecognitionClass;
  /** Safari and older Chromium browsers. */
  webkitSpeechRecognition?: BrowserSpeechRecognitionClass;
};
export class HomeVoiceError extends Error {
  constructor(readonly code: VoiceErrorCode) {
    super(code);
    this.name = "HomeVoiceError";
  }
}
export const unavailableHomeVoiceAdapter: HomeVoiceAdapter = {
  availability: async () => ({
    status: "unavailable",
    reason: "Dictation isn’t supported in this browser. You can still type your prompt.",
  }),
  async start() {
    throw new HomeVoiceError("unsupported");
  },
};
