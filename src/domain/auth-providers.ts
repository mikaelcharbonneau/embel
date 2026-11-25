export const authProviders = ["google", "apple", "chatgpt"] as const;
export type AuthProvider = (typeof authProviders)[number];
export const authProviderLabels: Record<AuthProvider, string> = {
  google: "Google",
  apple: "Apple",
  chatgpt: "ChatGPT",
};
