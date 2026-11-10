export type VoiceAvailability =
  | { status: "unavailable"; reason: string }
  | { status: "available"; transportId: string; language: string; disclosure: string };
export type VoiceErrorCode =
  "permission_denied" | "unsupported" | "no_speech" | "cancelled" | "transport" | "start_timeout" | "stop_unconfirmed";
export interface HomeVoiceAdapter {
  availability(language: string, signal: AbortSignal): Promise<VoiceAvailability>;
  start(input: {
    language: string;
    signal: AbortSignal;
    onTranscript(event: { text: string; final: boolean }): void;
    onError(code: VoiceErrorCode): void;
    onEnd(): void;
  }): Promise<{ stop(): Promise<void> }>;
}
export type OnDeviceSpeechEventMap = {
  start: Event;
  end: Event;
  error: { error: string };
  result: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; [index: number]: { transcript: string } }> };
};
export interface OnDeviceSpeechRecognition {
  processLocally?: boolean;
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  addEventListener<K extends keyof OnDeviceSpeechEventMap>(
    type: K,
    listener: (event: OnDeviceSpeechEventMap[K]) => void,
  ): void;
  removeEventListener<K extends keyof OnDeviceSpeechEventMap>(
    type: K,
    listener: (event: OnDeviceSpeechEventMap[K]) => void,
  ): void;
}
export type OnDeviceSpeechEnvironment = {
  isSecureContext: boolean;
  SpeechRecognition?: {
    new (): OnDeviceSpeechRecognition;
    available?: (options: {
      langs: string[];
      processLocally: true;
    }) => Promise<"unavailable" | "downloadable" | "downloading" | "available">;
  };
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
    reason: "On-device voice is unavailable in this browser. You can still type your prompt.",
  }),
  async start() {
    throw new HomeVoiceError("unsupported");
  },
};
