import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const checkBotId = vi.hoisted(() => vi.fn());
vi.mock("botid/server", () => ({ checkBotId }));
const createAuthTransitionClient = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/auth/client", () => ({ createAuthTransitionClient }));
const assertMutationOrigin = vi.hoisted(() => vi.fn());
const readJson = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/http/request", () => ({ assertMutationOrigin, readJson }));
vi.mock("../../src/server/config", () => ({ getApplicationOrigin: () => "https://embel.test" }));

import { POST as passwordReset } from "../../src/app/api/auth/password-reset/route";
import { POST as resendConfirmation } from "../../src/app/api/auth/resend-confirmation/route";
import { POST as signIn } from "../../src/app/api/auth/sign-in/route";
import { POST as signUp } from "../../src/app/api/auth/sign-up/route";

const bot = { isHuman: false, isBot: true, isVerifiedBot: false, bypassed: false };
const routes = {
  "sign-in": signIn,
  "sign-up": signUp,
  "password-reset": passwordReset,
  "resend-confirmation": resendConfirmation,
};

// The account forms are what a script would hammer to guess passwords, create accounts in bulk
// or send confirmation and reset emails. BotID answers before the body is read or Supabase called.
describe("BotID guard on the account forms", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", "1");
    checkBotId.mockReset().mockResolvedValue(bot);
    createAuthTransitionClient.mockReset();
    readJson.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  for (const [name, post] of Object.entries(routes)) {
    it(`answers 403 bot_detected on ${name} without reading the request or calling Supabase`, async () => {
      const response = await post(new Request(`https://embel.test/api/auth/${name}`, { method: "POST" }));
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("bot_detected");
      expect(readJson).not.toHaveBeenCalled();
      expect(createAuthTransitionClient).not.toHaveBeenCalled();
    });
  }
});
