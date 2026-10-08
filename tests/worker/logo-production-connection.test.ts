import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { IdentityPoolClientPort } from "../../src/server/runtime/identity-pool";
import { createLogoProductionConnection } from "../../worker/logo-production-connection";

const binding = { ownerId: "d0000000-0000-4000-8000-000000000001", roleName: "fluid_logo_worker_host_test", roleOid: 1234 };
const principal = () => ({ role_name: binding.roleName, active_role: binding.roleName, role_oid: "1234", owner_id: binding.ownerId });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture() {
  const c = Object.assign(new EventEmitter(), {
    query: vi.fn(async (input: { text: string }): Promise<{ rows: unknown[] }> => ({ rows: input.text.includes("session_user") ? [principal()] : [{ value: true }] })),
    release: vi.fn(), end: vi.fn(async () => {}),
  }) satisfies IdentityPoolClientPort;
  const pool = { connect: vi.fn(async () => c) };
  const input = { ...binding, pool, acquireTimeoutMs: 25, queryTimeoutMs: 25, disposalTimeoutMs: 25 };
  return { c, pool, input };
}
afterEach(() => vi.useRealTimers());
describe("checked dedicated non-generative connection", () => {
  it("constructs without I/O and rejects missing or non-logo bindings", async () => {
    const f = fixture();
    expect(createLogoProductionConnection()).toBeNull();
    for (const patch of [{ pool: null }, { roleName: "postgres" }, { roleName: "fluid_identity_test" }, { roleOid: 0 }, { ownerId: "wrong" }, { queryTimeoutMs: 0 }]) {
      expect(createLogoProductionConnection({ ...f.input, ...patch })).toBeNull();
    }
    const connection = createLogoProductionConnection(f.input)!;
    expect(connection).not.toBeNull(); expect(f.pool.connect).not.toHaveBeenCalled();
    await connection.close(); expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it("checks actual session, active role, OID and SQL owner on the same acquired client before every operation", async () => {
    const f = fixture(), connection = createLogoProductionConnection(f.input)!;
    await expect(connection.query("select operation($1)", [1])).resolves.toEqual({ rows: [{ value: true }] });
    await connection.query("select operation($1)", [2]);
    expect(f.pool.connect).toHaveBeenCalledTimes(2);
    expect(f.c.query.mock.calls.map(([q]) => q.text)).toEqual([
      expect.stringContaining("session_user"), "select operation($1)", expect.stringContaining("session_user"), "select operation($1)",
    ]);
    expect(f.c.release.mock.calls).toEqual([[false], [false]]); await connection.close();
  });
  it.each(["role_name", "active_role", "role_oid", "owner_id"])("fences mismatched %s without executing the operation", async field => {
    const f = fixture(); f.c.query.mockResolvedValue({ rows: [{ ...principal(), [field]: field === "role_oid" ? 5678 : "foreign" }] });
    const connection = createLogoProductionConnection(f.input)!;
    await expect(connection.query("select forbidden_dispatch()" )).rejects.toThrow("Logo production connection is unavailable.");
    expect(f.c.query).toHaveBeenCalledTimes(1); expect(f.c.release).toHaveBeenCalledWith(true); await connection.close();
  });
  it.each([{ rows: [] }, { rows: [principal(), principal()] }, { rows: [{ ...principal(), role_oid: "1234x" }] }])("rejects malformed principal rows", async ({ rows }) => {
    const f = fixture(); f.c.query.mockResolvedValue({ rows }); const connection = createLogoProductionConnection(f.input)!;
    await expect(connection.query("select dispatch()" )).rejects.toThrow("Logo production connection is unavailable.");
    expect(f.c.query).toHaveBeenCalledTimes(1); await connection.close();
  });
  it("preserves only exact validated register-plan conflict and sanitizes other driver failures", async () => {
    for (const [sql, message, expected] of [
      ["select public.register_logo_job_plan($1,$2,$3)", "plan_conflict", "plan_conflict"],
      ["select public.register_logo_job_plan($1,$2,$3)", "plan_conflict credential=private", "Logo production connection is unavailable."],
      ["select other_operation()", "plan_conflict", "Logo production connection is unavailable."],
    ]) {
      const f = fixture(); f.c.query.mockImplementation(async q => {
        if (q.text.includes("session_user")) return { rows: [principal()] };
        throw Error(message);
      });
      const connection = createLogoProductionConnection(f.input)!;
      await expect(connection.query(sql!)).rejects.toThrow(expected); await connection.close();
    }
    const f = fixture(); f.c.query.mockRejectedValue(Error("plan_conflict"));
    const connection = createLogoProductionConnection(f.input)!;
    await expect(connection.query("select public.register_logo_job_plan($1,$2,$3)")).rejects.toThrow("Logo production connection is unavailable."); await connection.close();
  });
  it("bounds an uncooperative query and discards its lease without dispatching after timeout", async () => {
    vi.useFakeTimers(); const f = fixture(), waiting = deferred<{ rows: unknown[] }>(); f.c.query.mockImplementation(() => waiting.promise);
    const connection = createLogoProductionConnection(f.input)!;
    const rejection = expect(connection.query("select dispatch()" )).rejects.toThrow("Logo production connection is unavailable.");
    await vi.advanceTimersByTimeAsync(30); await rejection;
    expect(f.c.release).toHaveBeenCalledExactlyOnceWith(true); await connection.close();
    waiting.resolve({ rows: [principal()] }); await Promise.resolve(); expect(f.c.query).toHaveBeenCalledTimes(1);
  });
  it("does not call a pending acquisition drained until a late lease is destroyed", async () => {
    vi.useFakeTimers(); const f = fixture(), waiting = deferred<IdentityPoolClientPort>(); f.pool.connect.mockImplementation(() => waiting.promise as Promise<typeof f.c>);
    const connection = createLogoProductionConnection(f.input)!;
    const rejected = expect(connection.query("select dispatch()" )).rejects.toThrow("Logo production connection is unavailable.");
    await vi.advanceTimersByTimeAsync(30); await rejected;
    let drained = false; const closing = connection.close().then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(5); expect(drained).toBe(false);
    waiting.resolve(f.c); await vi.advanceTimersByTimeAsync(0); await closing;
    expect(f.c.release).toHaveBeenCalledExactlyOnceWith(true); expect(f.c.query).not.toHaveBeenCalled();
  });
  it("rejects bounded close when acquisition remains unresolved rather than reporting a safe drain", async () => {
    vi.useFakeTimers(); const f = fixture(); f.pool.connect.mockImplementation(() => new Promise(() => {}));
    const connection = createLogoProductionConnection(f.input)!;
    const rejected = expect(connection.query("select dispatch()" )).rejects.toThrow("Logo production connection is unavailable.");
    await vi.advanceTimersByTimeAsync(30); await rejected;
    const closing = expect(connection.close()).rejects.toThrow("Logo production connection drain is unconfirmed.");
    await vi.advanceTimersByTimeAsync(30); await closing;
  });
  it("bounds failed release cleanup, retains error coverage and does not claim a confirmed drain", async () => {
    vi.useFakeTimers(); const f = fixture(); f.c.release.mockImplementation(() => { throw Error("private driver release"); }); f.c.end.mockImplementation(() => new Promise(() => {}));
    const connection = createLogoProductionConnection(f.input)!;
    const rejected = expect(connection.query("select operation()" )).rejects.toThrow("Logo production connection is unavailable.");
    await vi.advanceTimersByTimeAsync(30); await rejected;
    const closing = expect(connection.close()).rejects.toThrow("Logo production connection drain is unconfirmed.");
    await vi.advanceTimersByTimeAsync(30); await closing;
    expect(() => f.c.emit("error", Error("late private driver error"))).not.toThrow();
  });
  it("fences new queries synchronously while close drains an already dispatched operation", async () => {
    const f = fixture(), waiting = deferred<{ rows: unknown[] }>(), dispatched = deferred<void>();
    f.c.query.mockImplementation(async q => {
      if (q.text.includes("session_user")) return { rows: [principal()] };
      dispatched.resolve(); return waiting.promise;
    });
    const connection = createLogoProductionConnection(f.input)!;
    const query = connection.query("select already_dispatched()" ); await dispatched.promise;
    let drained = false; const closing = connection.close().then(() => { drained = true; });
    await expect(connection.query("select forbidden_new_operation()" )).rejects.toThrow("Logo production connection is unavailable.");
    expect(drained).toBe(false); waiting.resolve({ rows: [{ value: true }] }); await query; await closing;
    expect(drained).toBe(true); expect(f.pool.connect).toHaveBeenCalledTimes(1);
  });
  it("fences operation dispatch when its caller stops during the principal probe", async () => {
    const f = fixture(), waiting = deferred<{ rows: unknown[] }>(), begun = deferred<void>();
    f.c.query.mockImplementation(async q => {
      if (q.text.includes("session_user")) { begun.resolve(); return waiting.promise; }
      return { rows: [{ value: true }] };
    });
    const connection = createLogoProductionConnection(f.input)!, stop = new AbortController();
    const outcome = connection.query("select forbidden_after_stop()", [], stop.signal);
    await begun.promise; stop.abort(); waiting.resolve({ rows: [principal()] });
    await expect(outcome).rejects.toThrow("Logo production connection is unavailable.");
    expect(f.c.query).toHaveBeenCalledTimes(1); expect(f.c.release).toHaveBeenCalledExactlyOnceWith(true); await connection.close();
  });

  it("fences a caller-stopped acquisition and destroys its late client without any query", async () => {
    const f = fixture(), waiting = deferred<IdentityPoolClientPort>(), begun = deferred<void>();
    f.pool.connect.mockImplementation(() => { begun.resolve(); return waiting.promise as Promise<typeof f.c>; });
    const connection = createLogoProductionConnection(f.input)!, stop = new AbortController();
    const outcome = connection.query("select forbidden_after_stop()", [], stop.signal);
    await begun.promise; stop.abort(); waiting.resolve(f.c);
    await expect(outcome).rejects.toThrow("Logo production connection is unavailable."); await connection.close();
    expect(f.c.query).not.toHaveBeenCalled(); expect(f.c.release).toHaveBeenCalledExactlyOnceWith(true);
  });

});
