import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({ engineCall: vi.fn() }));
vi.mock("@/server/engine/database", () => ({ engineCall: mock.engineCall }));
import { GET } from "@/app/api/maintenance/expire-runs/route";

// Obvious fakes only: no database, and a made-up cron secret.
const SECRET = "c".repeat(32);
const call = (authorization?: string) =>
  new Request("http://localhost:3105/api/maintenance/expire-runs", {
    headers: authorization === undefined ? {} : { authorization },
  });
let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  mock.engineCall.mockResolvedValue({ ended: 0, failed: 0 });
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("scheduled sweep of overdue runs", () => {
  it("answers 503 and does nothing while no cron secret is configured", async () => {
    for (const secret of [undefined, "", "short"]) {
      if (secret === undefined) vi.stubEnv("CRON_SECRET", undefined as unknown as string);
      else vi.stubEnv("CRON_SECRET", secret);
      for (const header of [undefined, "Bearer ", `Bearer ${secret ?? ""}`, "Bearer undefined"]) {
        const response = await GET(call(header));
        expect(response.status, `${String(secret)} / ${String(header)}`).toBe(503);
        expect((await response.json()).error.code).toBe("integration_unavailable");
      }
    }
    expect(mock.engineCall).not.toHaveBeenCalled();
  });

  it("answers 401 and does nothing without the exact bearer secret", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const header of [
      undefined,
      "",
      SECRET,
      `Bearer ${SECRET}x`,
      `Bearer ${SECRET.slice(1)}`,
      `bearer ${SECRET}`,
      `Basic ${SECRET}`,
      `Bearer ${"x".repeat(32)}`,
    ]) {
      const response = await GET(call(header));
      expect(response.status, String(header)).toBe(401);
      expect(await response.text()).not.toContain(SECRET);
    }
    expect(mock.engineCall).not.toHaveBeenCalled();
  });

  it("runs the sweep once for Vercel Cron's header and answers with counts only", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    mock.engineCall.mockResolvedValueOnce({ ended: 3, failed: 0 });
    const response = await GET(call(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ ended: 3, failed: 0 });
    expect(mock.engineCall).toHaveBeenCalledTimes(1);
    expect(mock.engineCall).toHaveBeenCalledWith("engine_expire_overdue_runs", [200]);
    expect(info.mock.calls).toEqual([[JSON.stringify({ event: "overdue_runs_ended", ended: 3 })]]);
    expect(error).not.toHaveBeenCalled();
  });

  it("logs nothing when nothing was overdue", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect(await (await GET(call(`Bearer ${SECRET}`))).json()).toEqual({ ended: 0, failed: 0 });
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("reports runs the database could not end as an error line, still without ids", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    mock.engineCall.mockResolvedValueOnce({ ended: 1, failed: 2 });
    expect(await (await GET(call(`Bearer ${SECRET}`))).json()).toEqual({ ended: 1, failed: 2 });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain('"failed":"2"');
  });

  it("answers 500 without details when the database call fails or returns something else", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    mock.engineCall.mockRejectedValueOnce(new Error("connection refused at postgres://engine:pw@db"));
    let response = await GET(call(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/postgres|refused/);
    mock.engineCall.mockResolvedValueOnce({ ended: "many" });
    response = await GET(call(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    expect(info).not.toHaveBeenCalled();
  });
});
