import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_PROTECTED_ROUTES } from "../../src/domain/bot-protected-routes";

vi.mock("server-only", () => ({}));
const checkBotId = vi.hoisted(() => vi.fn());
vi.mock("botid/server", () => ({ checkBotId }));
const startGeneration = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/auth/context", () => ({
  getAuthenticatedContext: vi.fn(async () => ({ userId: "user-1" })),
}));
vi.mock("../../src/server/engine/start", () => ({
  startGeneration,
  WorkflowStartError: class WorkflowStartError extends Error {},
}));
vi.mock("../../src/server/engine/runs", () => ({
  startGenerationSchema: {},
  publicRun: (run: unknown) => run,
  listGenerations: vi.fn(),
}));
vi.mock("../../src/server/http/request", () => ({
  assertMutationOrigin: vi.fn(),
  readJson: vi.fn(async () => ({ kind: "engine.probe", idempotencyKey: "k" })),
}));

import { assertNotBot } from "../../src/server/http/bot-protection";
import { POST } from "../../src/app/api/projects/[projectId]/generations/route";

const human = { isHuman: true, isBot: false, isVerifiedBot: false, bypassed: false };
const bot = { isHuman: false, isBot: true, isVerifiedBot: false, bypassed: false };
const call = () =>
  POST(new Request("https://embel.test/api/projects/p1/generations", { method: "POST" }), {
    params: Promise.resolve({ projectId: "p1" }),
  });

describe("BotID guard on paid start routes", () => {
  let logged: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.stubEnv("VERCEL", "1");
    checkBotId.mockReset();
    startGeneration.mockReset();
    startGeneration.mockResolvedValue({ run: { id: "run-1" }, reused: false });
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    logged.mockRestore();
  });

  it("answers 403 bot_detected and starts nothing when BotID says bot", async () => {
    checkBotId.mockResolvedValue(bot);
    const response = await call();
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("bot_detected");
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it("lets a human through to start the generation", async () => {
    checkBotId.mockResolvedValue(human);
    const response = await call();
    expect(response.status).toBe(202);
    expect(startGeneration).toHaveBeenCalledTimes(1);
  });

  it("fails open and logs when BotID errors", async () => {
    checkBotId.mockRejectedValue(Object.assign(new Error("secret detail"), { code: "ECONNRESET" }));
    const response = await call();
    expect(response.status).toBe(202);
    expect(startGeneration).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain("botid_check_failed");
    expect(line).not.toContain("secret detail");
  });

  it("fails open when BotID is too slow", async () => {
    vi.useFakeTimers();
    checkBotId.mockReturnValue(new Promise(() => {}));
    const pending = assertNotBot();
    await vi.advanceTimersByTimeAsync(3001);
    await expect(pending).resolves.toBeUndefined();
    expect(String(logged.mock.calls[0]?.[0])).toContain("botid_check_failed");
  });

  it("skips the check outside Vercel", async () => {
    vi.stubEnv("VERCEL", "");
    checkBotId.mockResolvedValue(bot);
    await expect(assertNotBot()).resolves.toBeUndefined();
    expect(checkBotId).not.toHaveBeenCalled();
  });
});

describe("protected route list", () => {
  it("matches routes whose POST handler calls assertNotBot first", () => {
    for (const route of BOT_PROTECTED_ROUTES) {
      const file = `src/app${route.replace("*", "[projectId]")}/route.ts`;
      const source = readFileSync(file, "utf8");
      const handler = source.slice(source.indexOf("export async function POST"));
      expect(handler.slice(0, 400), file).toContain("await assertNotBot();");
    }
  });
});
