export const root: string;
export const fakeProviderPort: number;
export type JourneyStack = {
  settings: { webPort: number; apiPort: number; dbPort: number; projectId: string };
  appOrigin: string;
  apiUrl: string;
  secretKey: string;
  adminDatabaseUrl: string;
  enginePassword: string;
  fakeProviderOrigin: string;
  appEnvironment: Record<string, string>;
};
export function journeyStack(): JourneyStack;
