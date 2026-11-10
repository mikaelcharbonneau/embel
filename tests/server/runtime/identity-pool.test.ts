import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  createPooledIdentityConnectionFactory,
  type IdentityPoolPort,
  type IdentityPoolClientPort,
} from "@/server/runtime/identity-pool";
const owner = "d0000000-0000-4000-8000-000000000001";
const binding = { ownerId: owner, roleName: "fluid_identity_test", roleOid: 1234 };
const later = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
};
function client() {
  return Object.assign(new EventEmitter(), {
    query: vi.fn(async (): Promise<{ rows: unknown[] }> => ({ rows: [] })),
    release: vi.fn(),
    end: vi.fn(async () => {}),
  }) satisfies IdentityPoolClientPort;
}
afterEach(() => vi.useRealTimers());
it("never acquires a pool for an unconfigured owner", async () => {
  const c = client(),
    pool = { connect: vi.fn(async () => c) };
  const f = createPooledIdentityConnectionFactory([{ ...binding, pool }]);
  await expect(f.acquire("d0000000-0000-4000-8000-000000000002")).rejects.toMatchObject({
    code: "integration_unavailable",
  });
  expect(pool.connect).not.toHaveBeenCalled();
});
it("snapshots trusted binding and uses one client throughout the transaction", async () => {
  const c = client(),
    row = { ...binding, pool: { connect: vi.fn(async () => c) } };
  const f = createPooledIdentityConnectionFactory([row]);
  row.ownerId = "d0000000-0000-4000-8000-000000000002";
  const lease = await f.acquire(owner);
  expect(lease.binding).toEqual(binding);
  await lease.connection.query("BEGIN");
  await lease.connection.query("COMMIT");
  await lease.connection.release(false);
  expect(c.query.mock.calls).toHaveLength(2);
  expect(c.release).toHaveBeenCalledExactlyOnceWith(false);
  await expect(lease.connection.query("SELECT 1")).rejects.toMatchObject({ code: "integration_unavailable" });
});
it("destroys a late acquisition after cancellation", async () => {
  const waiting = later<IdentityPoolClientPort>(),
    c = client(),
    signal = new AbortController();
  const pool: IdentityPoolPort = { connect: () => waiting.promise };
  const f = createPooledIdentityConnectionFactory([{ ...binding, pool }]);
  const outcome = f.acquire(owner, signal.signal);
  signal.abort();
  await expect(outcome).rejects.toMatchObject({ code: "integration_unavailable" });
  waiting.resolve(c);
  await Promise.resolve();
  await Promise.resolve();
  expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
  expect(c.query).not.toHaveBeenCalled();
});
it("bounds acquisition and destroys a late connection after timeout", async () => {
  vi.useFakeTimers();
  const waiting = later<IdentityPoolClientPort>(),
    c = client();
  const f = createPooledIdentityConnectionFactory([{ ...binding, pool: { connect: () => waiting.promise } }], {
    acquireTimeoutMs: 50,
  });
  const outcome = f.acquire(owner);
  const rejection = expect(outcome).rejects.toMatchObject({ code: "integration_unavailable" });
  await vi.advanceTimersByTimeAsync(51);
  await rejection;
  waiting.resolve(c);
  await Promise.resolve();
  await Promise.resolve();
  expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
});
it("discards an active query on abort and cannot return it to the pool", async () => {
  const c = client(),
    waiting = later<{ rows: unknown[] }>();
  c.query.mockImplementation(() => waiting.promise);
  const signal = new AbortController(),
    f = createPooledIdentityConnectionFactory([{ ...binding, pool: { connect: async () => c } }]);
  const lease = await f.acquire(owner, signal.signal);
  const query = lease.connection.query("SELECT 1");
  signal.abort();
  await lease.connection.release(false);
  waiting.resolve({ rows: [] });
  await expect(query).rejects.toMatchObject({ code: "integration_unavailable" });
  expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
});
it("never returns a connection while a query is outstanding", async () => {
  const c = client(),
    waiting = later<{ rows: unknown[] }>();
  c.query.mockImplementation(() => waiting.promise);
  const f = createPooledIdentityConnectionFactory([{ ...binding, pool: { connect: async () => c } }]);
  const lease = await f.acquire(owner);
  const query = lease.connection.query("SELECT 1");
  await lease.connection.release(false);
  waiting.resolve({ rows: [] });
  await expect(query).rejects.toMatchObject({ code: "integration_unavailable" });
  expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
});

it("handles leased idle and active error events without uncaught process errors", async () => {
  for (const active of [false, true]) {
    const c = client(),
      waiting = later<{ rows: unknown[] }>(),
      f = createPooledIdentityConnectionFactory([{ ...binding, pool: { connect: async () => c } }]);
    const lease = await f.acquire(owner);
    let query: Promise<unknown> | undefined;
    if (active) {
      c.query.mockImplementation(() => waiting.promise);
      query = lease.connection.query("SELECT 1");
    }
    expect(() => c.emit("error", new Error("synthetic connection failure"))).not.toThrow();
    waiting.resolve({ rows: [] });
    if (query) await expect(query).rejects.toMatchObject({ code: "integration_unavailable" });
    await expect(lease.connection.query("SELECT 2")).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
  }
});
it("retains error coverage when release and fallback closure both fail", async () => {
  for (const discard of [false, true]) {
    const c = client();
    c.release.mockImplementation(() => {
      throw new Error("synthetic release failure");
    });
    c.end.mockRejectedValue(new Error("synthetic end failure"));
    const f = createPooledIdentityConnectionFactory([{ ...binding, pool: { connect: async () => c } }]);
    const lease = await f.acquire(owner);
    if (discard) await lease.connection.release(true);
    else await expect(lease.connection.release(false)).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(() => c.emit("error", new Error("late synthetic socket failure"))).not.toThrow();
  }
});
it("covers a late abandoned checkout whose release and end both fail", async () => {
  const c = client(),
    waiting = later<IdentityPoolClientPort>(),
    abort = new AbortController();
  c.release.mockImplementation(() => {
    throw new Error("synthetic release failure");
  });
  c.end.mockRejectedValue(new Error("synthetic end failure"));
  const f = createPooledIdentityConnectionFactory([{ ...binding, pool: { connect: () => waiting.promise } }]);
  const result = f.acquire(owner, abort.signal);
  abort.abort();
  await expect(result).rejects.toMatchObject({ code: "integration_unavailable" });
  waiting.resolve(c);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(() => c.emit("error", new Error("late synthetic socket failure"))).not.toThrow();
});
