import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createLocalExpiryCoordinator, runLocalExpiryTransaction } from "../../worker/local-expiry-maintenance";

function fixture(failAt?: string, rollbackFails = false) {
  const primary = Object.assign(new Error("Synthetic private error"), { code: "57014" });
  const commands: string[] = [], release = vi.fn();
  const client = { async query(sql: string) {
    commands.push(sql);
    if (sql === failAt) throw primary;
    if (sql === "ROLLBACK" && rollbackFails) throw new Error("Synthetic private rollback failure");
    return { rows: [{ count: 3 }] };
  }, release };
  const connect = vi.fn(async () => client);
  const pool = { connect } as unknown as Pick<Pool, "connect">;
  return { pool, client, connect, release, commands, primary };
}

describe("local expiry uses actual server transaction bounds", () => {
  it("pins BEGIN, both SET LOCAL settings, the existing RPC and COMMIT to one checked-out client", async () => {
    const value = fixture();
    const count = await runLocalExpiryTransaction(value.pool, new AbortController().signal, async database => {
      expect(database).toBe(value.client);
      const result = await database.query("select public.expire_job_leases() as count");
      return result.rows[0]!.count as number;
    });
    expect(count).toBe(3);
    expect(value.commands).toEqual(["BEGIN", "SET LOCAL statement_timeout = '10s'", "SET LOCAL lock_timeout = '1s'", "select public.expire_job_leases() as count", "COMMIT"]);
    expect(value.connect).toHaveBeenCalledOnce(); expect(value.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each(["SET LOCAL statement_timeout = '10s'", "SET LOCAL lock_timeout = '1s'", "select synthetic_expiry()", "COMMIT"])("rolls back acknowledged transaction work after %s fails", async failAt => {
    const value = fixture(failAt), work = vi.fn(async database => { await database.query("select synthetic_expiry()"); return 0; });
    await expect(runLocalExpiryTransaction(value.pool, new AbortController().signal, work)).rejects.toBe(value.primary);
    expect(value.commands.at(-1)).toBe("ROLLBACK");
    if (failAt.startsWith("SET LOCAL")) expect(work).not.toHaveBeenCalled();
    expect(value.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("destroys a connection after a lost BEGIN acknowledgement or failed rollback instead of returning an uncertain transaction to the pool", async () => {
    for (const value of [fixture("BEGIN"), fixture("select synthetic_expiry()", true)]) {
      await expect(runLocalExpiryTransaction(value.pool, new AbortController().signal, async database => { await database.query("select synthetic_expiry()"); return 0; })).rejects.toBe(value.primary);
      expect(value.release).toHaveBeenCalledExactlyOnceWith(true);
    }
  });

  it("never issues the RPC after an explicit stop during transaction setup", async () => {
    const value = fixture(), controller = new AbortController(), work = vi.fn();
    const query = value.client.query.bind(value.client);
    value.client.query = async sql => { const result = await query(sql); if (sql.startsWith("SET LOCAL lock_timeout")) controller.abort(); return result; };
    await expect(runLocalExpiryTransaction(value.pool, controller.signal, work)).rejects.toMatchObject({ name: "AbortError" });
    expect(work).not.toHaveBeenCalled(); expect(value.commands.at(-1)).toBe("ROLLBACK"); expect(value.release).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe("one serial local expiry lane", () => {
  it("coalesces concurrent attempts for one role and serializes Naming behind Strategy", async () => {
    let time = 0, finish!: (count: number) => void;
    const coordinator = createLocalExpiryCoordinator(() => time), signal = new AbortController().signal;
    const strategy = vi.fn(() => new Promise<number>(resolve => { finish = resolve; })), naming = vi.fn(async () => 2);
    const first = coordinator.run("strategy", signal, strategy), duplicate = coordinator.run("strategy", signal, strategy), next = coordinator.run("naming", signal, naming);
    expect(duplicate).toBe(first);
    await Promise.resolve(); expect(strategy).toHaveBeenCalledOnce(); expect(naming).not.toHaveBeenCalled();
    finish(1); expect(await first).toBe(1); expect(await next).toBe(2);
    expect(await coordinator.run("strategy", signal, strategy)).toBe(0); expect(strategy).toHaveBeenCalledOnce();
    time = 10_000;
    expect(await coordinator.run("naming", signal, naming)).toBe(2); expect(naming).toHaveBeenCalledTimes(2);
  });

  it("does not stack another server query after a client timeout and allows only a later normal due scan", async () => {
    let time = 0;
    const coordinator = createLocalExpiryCoordinator(() => time), signal = new AbortController().signal;
    const timeout = new Error("Query read timeout"), work = vi.fn().mockRejectedValueOnce(timeout).mockResolvedValue(0);
    await expect(coordinator.run("naming", signal, work)).rejects.toBe(timeout);
    for (time of [1_000, 3_000, 7_000, 9_999]) expect(await coordinator.run("naming", signal, work)).toBe(0);
    expect(work).toHaveBeenCalledOnce();
    time = 10_000; expect(await coordinator.run("naming", signal, work)).toBe(0); expect(work).toHaveBeenCalledTimes(2);
  });

  it("checks explicit cancellation before a queued role connects", async () => {
    const coordinator = createLocalExpiryCoordinator(), controller = new AbortController(), work = vi.fn(async () => 0);
    controller.abort();
    await expect(coordinator.run("naming", controller.signal, work)).rejects.toMatchObject({ name: "AbortError" }); expect(work).not.toHaveBeenCalled();
  });
});
