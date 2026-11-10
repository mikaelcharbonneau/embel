import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createPostgresHomeAttachmentBackend } from "../../helpers/home-attachment-postgres-backend";
import type { AuthenticatedContext } from "@/server/auth/context";
import type { IdentityConnectionFactory } from "@/server/data/identity-transaction";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const auth = { userId: owner } as AuthenticatedContext;
const input = {
  requestKey: randomUUID(),
  name: "note.txt",
  mimeType: "text/plain" as const,
  contentHash: "a".repeat(64),
};
function fixture() {
  const events: string[] = [],
    principal = { role_name: "fixture_home_a", role_oid: 2345, owner_id: owner };
  const connection = {
    async query(sql: string) {
      events.push(sql);
      return sql.includes("session_user") ? { rows: [principal] } : { rows: [{ value: null }] };
    },
    async release(discard: boolean) {
      events.push(discard ? "release-discard" : "release");
    },
    async discard() {
      events.push("discard");
    },
  };
  const owned: IdentityConnectionFactory = {
    async acquire() {
      return { connection, binding: { ownerId: owner, roleName: "fixture_home_a", roleOid: 2345 } };
    },
  };
  return { backend: createPostgresHomeAttachmentBackend(owned), principal, connection, events };
}
describe("Home private Postgres adapter capability fencing", () => {
  it("checks the real session principal and owner before a fixed parameterized lookup", async () => {
    const f = fixture();
    expect(await f.backend.lookup(auth, input.requestKey)).toBeNull();
    expect(f.events).toHaveLength(3);
    expect(f.events[1]).toBe("SELECT fluid_private.lookup_home_attachment($1::uuid) AS value");
    expect(f.events[2]).toBe("release");
  });
  it("rejects an actual foreign owner before any write even when the injected binding claims ours", async () => {
    const f = fixture();
    f.principal.owner_id = randomUUID();
    await expect(f.backend.prepare(auth, input, 5)).rejects.toMatchObject({ code: "not_found" });
    expect(f.events).toHaveLength(2);
    expect(f.events[1]).toBe("release-discard");
  });
  it("rejects changed role OID without making the write", async () => {
    const f = fixture();
    f.principal.role_oid++;
    await expect(f.backend.prepare(auth, input, 5)).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(f.events).toHaveLength(2);
  });
  it("hard-discards a failed release and never returns success", async () => {
    const f = fixture();
    f.connection.release = async () => {
      throw Error("release");
    };
    await expect(f.backend.lookup(auth, input.requestKey)).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(f.events.at(-1)).toBe("discard");
  });
  it("unconfigured database capability and pre-acquisition abort are unavailable", async () => {
    await expect(createPostgresHomeAttachmentBackend(null).lookup(auth, input.requestKey)).rejects.toMatchObject({
      code: "integration_unavailable",
    });
    const f = fixture(),
      c = new AbortController();
    c.abort();
    await expect(f.backend.lookup(auth, input.requestKey, c.signal)).rejects.toMatchObject({
      code: "integration_unavailable",
    });
    expect(f.events).toHaveLength(0);
  });
});
