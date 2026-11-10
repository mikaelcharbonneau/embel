import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { journeyStack } from "../journey/stack.mjs";
import { userFunctions } from "./client-functions";

// Pre-launch abuse test over HTTP (docs/architecture-review.md, M3), against this checkout's
// local Supabase stack only (npm run dev:up; loopback, test data, no OpenAI). User A is a
// script with nothing but the publishable key and its own session, calling PostgREST and
// Storage directly and in parallel, which the single-connection PGlite suites can't do.
// The database owner's connection is used only to set up fixtures and read the true ledger.
//
//   npm run dev:up && EMBEL_ABUSE_LOCAL_STACK=1 npx vitest run tests/qa/abuse-local-stack.test.ts
//
// Skipped unless EMBEL_ABUSE_LOCAL_STACK=1, so the ordinary suite and CI never need Docker.
const enabled = process.env.EMBEL_ABUSE_LOCAL_STACK === "1";
const HASH = "a".repeat(64);
const KINDS = { seven: "abuse.seven", twice: "abuse.twice", free: "abuse.free" } as const;

type Account = { id: string; client: SupabaseClient };
type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

describe.runIf(enabled)("a script calling the local Supabase stack directly", () => {
  let admin: pg.Client;
  let apiUrl: string, publishableKey: string, secretKey: string;
  let a: Account, b: Account;
  let settings: { paused: boolean; global_daily_cost_cap_microusd: string };

  async function account(): Promise<Account> {
    const service = createClient(apiUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const email = `abuse-${randomBytes(4).toString("hex")}@example.test`,
      password = randomBytes(18).toString("base64url");
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user)
      throw new Error(`Could not create a local test account: ${created.error?.message ?? "no user"}`);
    const client = createClient(apiUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw new Error(`Could not sign in the local test account: ${signedIn.error.message}`);
    return { id: created.data.user.id, client };
  }
  async function project(owner: Account, title = "Abuse test fixture") {
    const { data, error } = await owner.client.rpc("create_project", {
      p_scope: "complete_brand",
      p_title: title,
      p_context: { description: title },
      p_input_hash: HASH,
    });
    if (error) throw new Error(`create_project: ${error.message}`);
    return (data as { id: string }).id;
  }
  const start = (owner: Account, projectId: string, kind: string, key = `abuse-${randomUUID()}`, input: object = {}) =>
    owner.client.rpc("start_generation", {
      p_project_id: projectId,
      p_kind: kind,
      p_idempotency_key: key,
      p_input: input,
    }) as unknown as Promise<RpcResult>;
  async function ledger(owner: string) {
    const { rows } = await admin.query<{ balance: number; charges: number; refunds: number; grants: number }>(
      `
      select coalesce(sum(delta), 0)::int as balance, count(*) filter (where kind = 'charge')::int as charges,
             count(*) filter (where kind = 'refund')::int as refunds, count(*) filter (where kind in ('grant', 'adjustment'))::int as grants
        from public.credit_entries where owner_id = $1`,
      [owner],
    );
    return rows[0]!;
  }
  const messages = (results: RpcResult[]) => results.map((result) => result.error?.message ?? "ok").sort();

  beforeAll(async () => {
    const stack = journeyStack();
    apiUrl = stack.apiUrl;
    secretKey = stack.secretKey;
    publishableKey = stack.appEnvironment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
    if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(apiUrl) || !/@127\.0\.0\.1:\d+\//u.test(stack.adminDatabaseUrl))
      throw new Error("Not a loopback stack");
    admin = new pg.Client({ connectionString: stack.adminDatabaseUrl });
    await admin.connect();
    settings = (
      await admin.query("select paused, global_daily_cost_cap_microusd::text from fluid_private.engine_settings")
    ).rows[0];
    await admin.query(
      "update fluid_private.engine_settings set paused = false, global_daily_cost_cap_microusd = 50000000",
    );
    await admin.query(
      `insert into fluid_private.generation_kinds (kind, credits, enabled, max_per_day) values ($1, 7, true, 50), ($2, 0, true, 2), ($3, 0, true, 50)
      on conflict (kind) do update set credits = excluded.credits, enabled = true, max_per_day = excluded.max_per_day`,
      [KINDS.seven, KINDS.twice, KINDS.free],
    );
    a = await account();
    b = await account();
    // Each account receives its monthly allowance on first use; take it before any snapshot.
    for (const owner of [a, b])
      expect((await owner.client.rpc("get_credit_summary")).data).toMatchObject({ planId: "free", balance: 30 });
  }, 60_000);
  afterAll(async () => {
    if (!admin) return;
    await admin.query("update fluid_private.generation_kinds set enabled = false where kind like 'abuse.%'");
    if (settings)
      await admin.query("update fluid_private.engine_settings set paused = $1, global_daily_cost_cap_microusd = $2", [
        settings.paused,
        settings.global_daily_cost_cap_microusd,
      ]);
    await admin.end();
  });

  it("gives signed-in callers exactly the reviewed functions and anonymous callers none, on the real stack", async () => {
    const { rows } = await admin.query<{ signature: string; anon: boolean; authenticated: boolean }>(`
      select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'fluid_private')`);
    expect(rows.filter((row) => row.anon).map((row) => row.signature)).toEqual([]);
    expect(new Set(rows.filter((row) => row.authenticated).map((row) => row.signature))).toEqual(userFunctions);
  });

  it("admits exactly what the credits allow when many starts race in parallel", async () => {
    const projects = await Promise.all(Array.from({ length: 12 }, () => project(a)));
    const results = await Promise.all(projects.map((id) => start(a, id, KINDS.seven)));
    expect(messages(results)).toEqual([...Array(8).fill("insufficient_credits"), ...Array(4).fill("ok")].sort());
    expect(await ledger(a.id)).toEqual({ balance: 2, charges: 4, refunds: 0, grants: 1 });
  }, 60_000);

  it("creates one run for one idempotency key however many parallel requests carry it", async () => {
    const id = await project(a),
      key = `abuse-same-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => start(a, id, KINDS.free, key)));
    expect(results.map((result) => result.error)).toEqual(Array(20).fill(null));
    expect(new Set(results.map((result) => (result.data as { id: string }).id)).size).toBe(1);
    expect(
      (
        await admin.query(
          "select count(*)::int as n from public.generation_runs where owner_id = $1 and idempotency_key = $2",
          [a.id, key],
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  }, 60_000);

  it("holds the daily limit when parallel starts race on different projects", async () => {
    const projects = await Promise.all(Array.from({ length: 8 }, () => project(a)));
    const results = await Promise.all(projects.map((id) => start(a, id, KINDS.twice)));
    expect(messages(results)).toEqual([...Array(6).fill("daily_limit"), ...Array(2).fill("ok")].sort());
  }, 60_000);

  it("refuses forged parameters, other owners' projects, a paused engine and a reached cost cap", async () => {
    const mine = await project(a),
      theirs = await project(b, "B's private brand");
    const before = { a: await ledger(a.id), b: await ledger(b.id) };
    // No price, owner or plan parameter exists; PostgREST finds no such function.
    const extra = await a.client.rpc("start_generation", {
      p_project_id: mine,
      p_kind: KINDS.seven,
      p_idempotency_key: `abuse-${randomUUID()}`,
      p_input: {},
      p_credits: -100,
    });
    expect(extra.error?.code).toBe("PGRST202");
    expect((await start(a, mine, KINDS.seven, undefined, { text: "x".repeat(70_000) })).error?.message).toBe(
      "invalid_input",
    );
    expect((await start(a, mine, KINDS.seven, "short")).error?.message).toBe("invalid_input");
    expect((await start(a, theirs, KINDS.seven)).error?.message).toBe("not_found");
    expect((await start(a, mine, "strategy.unknown")).error?.message).toBe("generation_unavailable");
    await admin.query("update fluid_private.engine_settings set paused = true");
    try {
      expect((await start(a, mine, KINDS.free)).error?.message).toBe("generation_paused");
    } finally {
      await admin.query("update fluid_private.engine_settings set paused = false");
    }
    // B's run records provider cost over the cap (as the engine login would); A is stopped too.
    const run = (await start(b, theirs, KINDS.free)).data as { id: string };
    await admin.query("select fluid_private.engine_claim($1, 'wrun_abuse_cap')", [run.id]);
    await admin.query("select fluid_private.engine_save_output($1, 'echo', '{}'::jsonb, null, 5)", [run.id]);
    await admin.query("select fluid_private.engine_finish($1, 'succeeded', null)", [run.id]);
    await admin.query("update fluid_private.engine_settings set global_daily_cost_cap_microusd = 1");
    try {
      expect((await start(a, mine, KINDS.free)).error?.message).toBe("generation_paused");
    } finally {
      await admin.query("update fluid_private.engine_settings set global_daily_cost_cap_microusd = 50000000");
    }
    expect({ a: await ledger(a.id), b: await ledger(b.id) }).toEqual(before);
  }, 60_000);

  it("cannot reach engine, credit or account deletion functions through the API", async () => {
    const theirs = await project(b);
    const run = (await start(b, theirs, KINDS.free)).data as { id: string };
    const before = { a: await ledger(a.id), b: await ledger(b.id) };
    // The private schema is not exposed at all.
    for (const [fn, args] of [
      ["engine_finish", { p_run_id: run.id, p_status: "succeeded", p_error: null }],
      ["finish_generation_run", { p_run_id: run.id, p_status: "cancelled", p_error: null }],
      ["ensure_credit_period", { p_owner: a.id }],
      ["engine_save_output", { p_run_id: run.id, p_key: "x", p_output: {}, p_response_id: null, p_cost: 0 }],
    ] as const) {
      const result = await a.client.schema("fluid_private").rpc(fn, args);
      expect(result.error?.code, fn).toBe("PGRST106");
    }
    for (const [fn, args] of [
      ["account_deletion_begin", { p_owner: b.id }],
      ["account_deletion_purge", { p_owner: b.id }],
      ["account_deletion_complete", { p_owner: b.id }],
      ["account_storage_objects", { p_owner: b.id }],
      ["account_deletions_pending", {}],
      ["orphaned_storage_objects", {}],
    ] as const) {
      const result = await a.client.rpc(fn, args);
      expect(result.error?.code, fn).toBe("42501");
    }
    expect((await a.client.rpc("cancel_generation", { p_run_id: run.id })).error?.message).toBe("not_found");
    expect(
      (await admin.query("select status, cancel_requested_at from public.generation_runs where id = $1", [run.id]))
        .rows,
    ).toEqual([{ status: "queued", cancel_requested_at: null }]);
    expect(
      (
        await admin.query(
          "select count(*)::int as n from fluid_private.account_deletion_receipts where pending_owner_id = $1",
          [b.id],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    expect({ a: await ledger(a.id), b: await ledger(b.id) }).toEqual(before);
  }, 60_000);

  it("cannot write credits, runs, outputs or B's projects through the tables, and reads only its own rows", async () => {
    const mine = await project(a),
      theirs = await project(b, "B's private brand");
    const ownRun = (await start(a, mine, KINDS.free)).data as { id: string };
    const before = {
      a: await ledger(a.id),
      b: await ledger(b.id),
      spend: (await admin.query("select coalesce(sum(cost_microusd),0)::text as n from public.generation_outputs"))
        .rows[0].n,
    };
    const attempts = [
      a.client.from("credit_entries").insert({ owner_id: a.id, delta: 1000, kind: "grant", note: "free money" }),
      a.client.from("credit_entries").update({ delta: 1000 }).eq("owner_id", a.id),
      a.client.from("credit_entries").delete().eq("owner_id", a.id),
      a.client.from("credit_accounts").update({ plan_id: "studio" }).eq("owner_id", a.id),
      a.client.from("generation_runs").insert({
        owner_id: a.id,
        project_id: mine,
        kind: KINDS.seven,
        idempotency_key: `abuse-${randomUUID()}`,
        input: {},
        credits: 0,
      }),
      a.client.from("generation_runs").update({ status: "failed", credits: 0 }).eq("id", ownRun.id),
      a.client
        .from("generation_outputs")
        .insert({ run_id: ownRun.id, owner_id: a.id, output_key: "forged", output: {}, cost_microusd: 0 }),
      a.client.from("generation_outputs").update({ cost_microusd: 0 }).eq("owner_id", a.id),
      a.client.from("projects").update({ title: "taken" }).eq("id", theirs),
      a.client.from("projects").delete().eq("id", theirs),
      a.client.from("projects").insert({ owner_id: b.id, scope: "complete_brand", title: "planted" }),
    ];
    for (const [index, result] of (await Promise.all(attempts)).entries())
      expect(result.error?.code, `attempt ${index}`).toBe("42501");
    // B has rows in every one of these tables by now.
    for (const table of ["projects", "generation_runs", "generation_outputs", "credit_entries", "credit_accounts"]) {
      expect(
        (await admin.query(`select count(*)::int as n from public.${table} where owner_id = $1`, [b.id])).rows[0].n,
        table,
      ).toBeGreaterThan(0);
      const { data, error } = await a.client.from(table).select("owner_id");
      expect(error, table).toBeNull();
      expect(
        (data ?? []).filter((row) => (row as { owner_id: string }).owner_id !== a.id),
        table,
      ).toEqual([]);
    }
    expect((await a.client.from("projects").select("id,title").eq("id", theirs)).data).toEqual([]);
    expect((await admin.query("select title from public.projects where id = $1", [theirs])).rows).toEqual([
      { title: "B's private brand" },
    ]);
    const after = {
      a: await ledger(a.id),
      b: await ledger(b.id),
      spend: (await admin.query("select coalesce(sum(cost_microusd),0)::text as n from public.generation_outputs"))
        .rows[0].n,
    };
    expect(after).toEqual(before);
  }, 60_000);

  it("cannot read, sign, list, overwrite or delete B's private files", async () => {
    const theirs = await project(b),
      asset = randomUUID(),
      version = randomUUID();
    const path = `${b.id}/${theirs}/${asset}/${version}`;
    await admin.query(
      "insert into public.assets(id, owner_id, project_id, kind) values ($1, $2, $3, 'abuse_fixture')",
      [asset, b.id, theirs],
    );
    await admin.query(
      `insert into public.asset_versions(id, owner_id, project_id, asset_id, version, input_revision, input_hash, content_hash, mime_type, provenance, storage_path)
      values ($1, $2, $3, $4, 1, 1, $5, $5, 'image/png', '{"source":"abuse_local_fixture"}', $6)`,
      [version, b.id, theirs, asset, HASH, path],
    );
    const service = createClient(apiUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const bytes = new Uint8Array(randomBytes(64));
    const uploaded = await service.storage.from("fluid-assets").upload(path, bytes, { contentType: "image/png" });
    expect(uploaded.error).toBeNull();
    // Positive control: B, the owner, can sign its own file.
    expect((await b.client.storage.from("fluid-assets").createSignedUrl(path, 60)).error).toBeNull();
    const bucket = a.client.storage.from("fluid-assets");
    expect((await bucket.download(path)).data).toBeNull();
    expect((await bucket.createSignedUrl(path, 60)).data).toBeNull();
    expect((await bucket.createSignedUrls([path], 60)).data?.every((entry) => !entry.signedUrl) ?? true).toBe(true);
    expect((await bucket.list(`${b.id}/${theirs}/${asset}`)).data ?? []).toEqual([]);
    expect(
      (await bucket.upload(path, new Uint8Array([1, 2, 3]), { contentType: "image/png", upsert: true })).error,
    ).not.toBeNull();
    expect(
      (
        await bucket.upload(`${b.id}/${theirs}/${randomUUID()}/${randomUUID()}`, new Uint8Array([1]), {
          contentType: "image/png",
        })
      ).error,
    ).not.toBeNull();
    expect((await bucket.remove([path])).data ?? []).toEqual([]);
    const stored = await service.storage.from("fluid-assets").download(path);
    expect(Buffer.from(await stored.data!.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
  }, 60_000);

  it("holds the export limit of three a day against parallel requests, and refuses anonymous callers", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => a.client.rpc("admit_account_export") as unknown as Promise<RpcResult>),
    );
    expect(messages(results)).toEqual([...Array(7).fill("export_rate_limited"), ...Array(3).fill("ok")].sort());
    const anonymous = createClient(apiUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    expect((await anonymous.rpc("admit_account_export")).error?.code).toBe("42501");
    expect(
      (
        await anonymous.rpc("start_generation", {
          p_project_id: randomUUID(),
          p_kind: KINDS.free,
          p_idempotency_key: `abuse-${randomUUID()}`,
          p_input: {},
        })
      ).error?.code,
    ).toBe("42501");
    expect((await b.client.rpc("admit_account_export")).error).toBeNull();
  }, 60_000);
});
