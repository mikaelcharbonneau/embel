export function prepareJourneyDatabase(): Promise<void>;
export function createJourneyAccount(): Promise<{ email: string; password: string; userId: string }>;
