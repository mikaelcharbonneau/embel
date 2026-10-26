import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { NamingBrainJobStore, type NamingWorkerStatus } from "../../worker/naming-brain-store";
import { createNamingBrainPolicy } from "../../src/server/ai/naming-brain/policy";
import { startNamingWorkerAuthority, type NamingWorkerAuthority } from "../../services/naming-worker/authority";
import { runNamingPolling } from "../../services/naming-worker/scheduling";
import { runOneJob } from "../../worker/runner";
import { namingPreferencesRuntimeFingerprint } from "../../worker/naming-brain-configuration";
import { id } from "../domain/naming-brain-fixtures";

afterEach(() => vi.useRealTimers());
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture() {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(0);
  const now = () => performance.now(), controller = new AbortController();
  const status = (values: Partial<NamingWorkerStatus> = {}): NamingWorkerStatus => ({ version: 1, leader: true, generation: 1,
    serverTime: new Date(Date.UTC(2030, 0, 1) + now()).toISOString(), expiresAt: new Date(Date.UTC(2030, 0, 1) + now() + 60_000).toISOString(), ready: true, reason: "leader", ...values });
  const calls: { action: string; at: number; values: unknown[] }[] = [];
  const report = vi.fn(async (_generation: number | null) => status());
  const database = { query: vi.fn(async (sql: string, values: unknown[] = []): Promise<{ rows: { result: unknown }[] }> => {
    const action = sql.includes("report_naming_brain_worker_status") ? "status" : String(values[3]);
    calls.push({ action, at: now(), values });
    return { rows: [{ result: action === "status" ? await report(values[3] as number | null)
      : action === "preference_work" ? [] : action === "claim" ? null : action === "assert_continue" ? true : 0 }] };
  }) };
  let authority: NamingWorkerAuthority | undefined;
  const store = new NamingBrainJobStore(database, "synthetic-deployment", () => {
    const lease = authority?.current(); return lease ? { workerId: "synthetic-worker", generation: lease.generation } : null;
  });
  const start = async () => { authority = await startNamingWorkerAuthority({ signal: controller.signal, now, random: () => 1,
    report: generation => store.reportWorkerStatus(createNamingBrainPolicy("synthetic-model"), "synthetic-worker", generation) }); return authority; };
  return { now, controller, status, calls, report, database, store, start };
}

describe("Hosted Naming authority through the actual versioned SQL store adapter", () => {
  it("counts23 actual RPCs per steady no-work minute and only3 status calls for a follower", async () => {
    const f = fixture(), authority = await f.start();
    const pending = runNamingPolling({ signal: f.controller.signal, generation: () => authority.current()?.generation ?? null, now: f.now,
      attestPreferences: () => f.store.attestPendingPreferences(), expireLeases: () => f.store.expireLeases("synthetic-worker"),
      runJob: () => runOneJob({ store: f.store, handlers: new Map([["naming.generate", { steps: () => [] }]]), workerId: "synthetic-worker", signal: f.controller.signal }) });
    await vi.advanceTimersByTimeAsync(120_000);
    const minute = f.calls.filter(call => call.at >= 60_000 && call.at < 120_000);
    expect(minute).toHaveLength(23);
    expect(Object.fromEntries(["status", "preference_work", "expire_leases", "claim"].map(action => [action, minute.filter(call => call.action === action).length])))
      .toEqual({ status: 3, preference_work: 4, expire_leases: 4, claim: 12 });
    f.controller.abort(); await pending; await authority.stop();
  });

  it("keeps a healthy competing publisher a follower with bounded status attempts and no maintenance RPC", async () => {
    const f = fixture(); f.report.mockImplementation(async () => f.status({ leader: false, generation: null, expiresAt: null, ready: false, reason: "held" }));
    const authority = await f.start();
    const pending = runNamingPolling({ signal: f.controller.signal, generation: () => authority.current()?.generation ?? null, now: f.now,
      attestPreferences: () => f.store.attestPendingPreferences(), expireLeases: () => f.store.expireLeases("synthetic-worker"), runJob: async () => "idle" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.calls.filter(call => call.at >= 60_000 && call.at < 120_000)).toHaveLength(3);
    expect(f.calls.every(call => call.action === "status")).toBe(true);
    await expect(f.store.claim("synthetic-worker", 120)).rejects.toThrow("naming_worker_authority_unavailable");
    f.controller.abort(); await pending; await authority.stop();
  });

  it("makes a saved preference change just after a scan wait nearly15s for attestation, separately from queued-job pickup", async () => {
    const f = fixture(), authority = await f.start(), query = f.database.query.getMockImplementation()!;
    let changed = false, attestedAt: number | undefined;
    const preferences = { version: 2, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null,
      approaches: ["real_words"], directness: "open_ended", sourceLanguages: [], heritageNotes: "", culturalNotes: "", requiredText: [], excludedText: [] };
    f.database.query.mockImplementation(async (sql, values = []) => {
      const result = await query(sql, values), action = values[3];
      if (action === "preference_work" && changed) return { rows: [{ result: [{ ownerId: id(1), projectId: id(2), preferencesVersion: 2,
        preferences, preferencesHash: "a".repeat(64), expectedFingerprint: namingPreferencesRuntimeFingerprint() }] }] };
      if (action === "attest_preferences") {
        const payload = JSON.parse(String(values[4])); changed = false; attestedAt = f.now();
        return { rows: [{ result: { attestationId: id(3), ...payload, ready: payload.readiness.ready, missing: payload.readiness.missing } }] };
      }
      return result;
    });
    const pending = runNamingPolling({ signal: f.controller.signal, generation: () => authority.current()?.generation ?? null, now: f.now,
      attestPreferences: () => f.store.attestPendingPreferences(), expireLeases: () => f.store.expireLeases("synthetic-worker"),
      runJob: () => runOneJob({ store: f.store, handlers: new Map([["naming.generate", { steps: () => [] }]]), workerId: "synthetic-worker", signal: f.controller.signal }) });
    await vi.advanceTimersByTimeAsync(1); const savedAt = f.now(); changed = true;
    await vi.advanceTimersByTimeAsync(14_998); expect(attestedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); expect(attestedAt).toBe(15_000); expect(attestedAt! - savedAt).toBe(14_999);
    expect(f.calls.filter(call => call.action === "attest_preferences")).toHaveLength(1);
    f.controller.abort(); await pending; await authority.stop();
  });

  it("retains maintenance when paid readiness is false without granting paid dispatch", async () => {
    const f = fixture(); f.report.mockImplementation(async () => f.status({ ready: false }));
    const authority = await f.start(); expect(authority.current()).toEqual({ generation: 1 });
    await expect(authority.assertReady()).rejects.toThrow("naming_readiness_unavailable");
    await f.store.attestPendingPreferences(); await f.store.expireLeases("synthetic-worker");
    expect(f.calls.map(call => call.action)).toEqual(["status", "preference_work", "expire_leases"]);
    await authority.stop();
  });

  it("does not attest a batch selected under an earlier generation", async () => {
    const f = fixture(); let generation = 1;
    const query = vi.fn(async () => {
      generation = 2;
      return { rows: [{ result: [{ ownerId: id(1), projectId: id(2), preferencesVersion: 2, preferencesHash: "a".repeat(64), expectedFingerprint: namingPreferencesRuntimeFingerprint(),
        preferences: { version: 2, creativeLocale: "en", notes: "", minimumGraphemes: null, maximumGraphemes: null, approaches: ["real_words"], directness: "open_ended",
          sourceLanguages: [], heritageNotes: "", culturalNotes: "", requiredText: [], excludedText: [] } }] }] };
    });
    const store = new NamingBrainJobStore({ query }, "synthetic-deployment", () => ({ workerId: "synthetic-worker", generation }));
    await expect(store.attestPendingPreferences()).rejects.toThrow("naming_worker_authority_unavailable");
    expect(query).toHaveBeenCalledOnce(); expect(f.database.query).not.toHaveBeenCalled();
  });

  it("uses server remaining lifetime and monotonic elapsed time despite wallclock skew/regression", async () => {
    const f = fixture(); vi.setSystemTime(Date.UTC(2099, 0, 1));
    const authority = await f.start(); expect(authority.current()).not.toBeNull();
    vi.setSystemTime(-1_000_000); await vi.advanceTimersByTimeAsync(10_000); expect(authority.current()).not.toBeNull();
    await authority.assertReady(); expect(f.report).toHaveBeenLastCalledWith(1); await authority.stop();
  });

  it("does not extend a nearly expired lost-ack acquisition replay to a fresh minute", async () => {
    const f = fixture(); f.report.mockResolvedValue(f.status({ expiresAt: new Date(Date.UTC(2030, 0, 1) + 1500).toISOString() }));
    const authority = await f.start(); expect(authority.current()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(501); expect(authority.current()).toBeNull();
    await expect(authority.assertReady()).rejects.toThrow("naming_readiness_unavailable");
    expect(f.report).toHaveBeenCalledOnce(); await authority.stop();
  });

  it("rejects an acquisition response delayed beyond its lease rather than granting fresh authority on arrival", async () => {
    const f = fixture(), response = deferred<NamingWorkerStatus>(); f.report.mockReturnValue(response.promise);
    const old = f.status(); const starting = f.start(); await vi.advanceTimersByTimeAsync(70_000); response.resolve(old);
    const authority = await starting; expect(authority.current()).toBeNull();
    await expect(authority.assertReady()).rejects.toThrow("naming_readiness_unavailable"); await authority.stop();
  });

  it("coalesces manual assertions and periodic renewal into one pending status query", async () => {
    const f = fixture(), authority = await f.start(), response = deferred<NamingWorkerStatus>(); f.report.mockReturnValue(response.promise);
    const assertions = Promise.all([authority.assertReady(), authority.assertReady(), authority.assertReady()]);
    await vi.advanceTimersByTimeAsync(20_000); expect(f.report).toHaveBeenCalledTimes(2);
    response.resolve(f.status()); await assertions; await authority.stop();
  });

  it("backs off an unavailable database, makes7 attempts in120s and never falls back to legacy RPCs", async () => {
    const f = fixture(); f.report.mockRejectedValue(new Error("synthetic-private-sql-42883"));
    const authority = await f.start();
    for (let i = 0; i < 100; i++) await expect(authority.assertReady()).rejects.toThrow("naming_readiness_unavailable");
    await vi.advanceTimersByTimeAsync(120_000); expect(f.report).toHaveBeenCalledTimes(7);
    expect(f.calls.every(call => call.action === "status")).toBe(true); expect(authority.current()).toBeNull(); await authority.stop();
  });

  it("rejects changed generations in a renewal without adopting their authority", async () => {
    const f = fixture(), authority = await f.start(); f.report.mockResolvedValueOnce(f.status({ generation: 2 }));
    await expect(authority.assertReady()).rejects.toThrow("naming_readiness_unavailable");
    expect(authority.current()).toBeNull(); await authority.stop();
  });

  it("fences shutdown immediately and drains a late successful response without restoring authority", async () => {
    const f = fixture(), authority = await f.start(), response = deferred<NamingWorkerStatus>(); f.report.mockReturnValue(response.promise);
    const assertion = Promise.allSettled([authority.assertReady()]); await vi.advanceTimersByTimeAsync(1);
    f.controller.abort(); expect(authority.current()).toBeNull(); let stopped = false;
    const stopping = authority.stop().then(() => { stopped = true; }); await vi.advanceTimersByTimeAsync(60_000); expect(stopped).toBe(false);
    response.resolve(f.status()); await stopping;
    expect(await assertion).toMatchObject([{ status: "rejected", reason: new Error("naming_readiness_stopped") }]);
    const count = f.report.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000); expect(f.report).toHaveBeenCalledTimes(count);
  });
});
