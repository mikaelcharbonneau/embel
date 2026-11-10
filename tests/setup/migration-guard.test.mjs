import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  checkChanges,
  checkFunctionGrants,
  checkNames,
  checkRepository,
  checkSecrets,
  functionList,
  parseNameStatus,
  runGuards,
  stripSql,
} from "../../scripts/ci/migration-guard.mjs";
import { checkHistory, parseMigrationList } from "../../scripts/ci/migration-history.mjs";

const run = promisify(execFile);
const rules = (findings) => findings.map((finding) => finding.rule);
const A = "20261110190000_baseline.sql",
  B = "20261110200000_second.sql",
  C = "20261111100000_third.sql";

test("names: pattern, uniqueness and strictly increasing versions", () => {
  assert.deepEqual(checkNames([A, B]), []);
  assert.equal(checkNames([A, "20261110200000_Second.sql"]).length, 1);
  assert.equal(checkNames(["local20261110200000_x.sql"]).length, 1);
  assert.equal(checkNames([A, "2026111020000_short.sql"]).length, 1);
  assert.equal(checkNames([A, "20261110190000_other.sql"]).length, 1);
  assert.equal(checkNames([A, "20261110200000_x.sql.bak"]).length, 1);
});

test("names: a new migration must sort after everything on the base branch", () => {
  assert.deepEqual(checkNames([A, B, C], { addedNames: [C], baseNames: [A, B] }), []);
  const late = checkNames([A, B, "20261110195000_late.sql"], {
    addedNames: ["20261110195000_late.sql"],
    baseNames: [A, B],
  });
  assert.equal(late.length, 1);
  assert.match(late[0].message, /not after 20261110200000/);
});

test("history and archive: only additions to migrations; nothing added to the archive", () => {
  const changes = parseNameStatus(
    "A\0supabase/migrations/a.sql\0M\0supabase/migrations/b.sql\0D\0supabase/migrations/c.sql\0A\0supabase/archive/x/y.sql\0M\0supabase/archive/x/z.sql\0D\0supabase/archive/q.sql\0",
  );
  const findings = checkChanges(changes);
  assert.deepEqual(
    findings.map((f) => [f.rule, f.file]),
    [
      ["history", "supabase/migrations/b.sql"],
      ["history", "supabase/migrations/c.sql"],
      ["archive", "supabase/archive/x/y.sql"],
    ],
  );
  assert.deepEqual(checkChanges(parseNameStatus("A\0supabase/migrations/a.sql\0")), []);
});

test("stripSql blanks comments, strings and dollar-quoted bodies but keeps offsets", () => {
  const sql = "select 1; -- create function x()\nselect 'a;b'; /* create function y() */ $f$ create function z(); $f$;";
  const clean = stripSql(sql);
  assert.equal(clean.length, sql.length);
  assert.doesNotMatch(clean, /create function/);
  assert.equal(clean.split("\n").length, sql.split("\n").length);
});

test("functionList splits on top-level commas and normalises names", () => {
  assert.deepEqual(functionList('public.a(uuid, text), "Public"."B"(int,interval), c()'), [
    "public.a",
    "Public.B",
    "public.c",
  ]);
});

const create = (name, tail = "returns void language sql as $$ select 1 $$") =>
  `create function ${name}(p uuid) ${tail};\n`;

test("grants: a public function needs a revoke and a grant, in that file, after the create", () => {
  const good =
    create("public.f") +
    "revoke all on function public.f(uuid) from public, anon, authenticated;\ngrant execute on function public.f(uuid) to service_role;\n";
  assert.deepEqual(checkFunctionGrants("m.sql", good), []);
  const noRevoke = create("public.f") + "grant execute on function public.f(uuid) to service_role;\n";
  assert.equal(checkFunctionGrants("m.sql", noRevoke).length, 1);
  const noGrant = create("public.f") + "revoke all on function public.f(uuid) from public;\n";
  assert.equal(checkFunctionGrants("m.sql", noGrant).length, 1);
  assert.equal(checkFunctionGrants("m.sql", create("public.f")).length, 2);
  const before =
    "revoke all on function public.f(uuid) from public;\ngrant execute on function public.f(uuid) to service_role;\n" +
    create("public.f");
  assert.equal(checkFunctionGrants("m.sql", before).length, 2, "statements before the create do not count");
});

test("grants: revoke from service_role alone does not make a function private", () => {
  const sql =
    create("public.f") +
    "revoke all on function public.f(uuid) from service_role;\ngrant execute on function public.f(uuid) to service_role;\n";
  assert.equal(checkFunctionGrants("m.sql", sql).length, 1);
});

test("grants: private schemas and trigger functions need no grant, but still a revoke", () => {
  const priv =
    create("fluid_private.f") +
    "revoke all on function fluid_private.f(uuid) from public, anon, authenticated, service_role;\n";
  assert.deepEqual(checkFunctionGrants("m.sql", priv), []);
  assert.equal(checkFunctionGrants("m.sql", create("fluid_private.f")).length, 1);
  const trigger =
    create("public.t", "returns trigger language plpgsql as $$ begin return new; end $$") +
    "revoke all on function public.t(uuid) from public;\n";
  assert.deepEqual(checkFunctionGrants("m.sql", trigger), []);
});

test("grants: one statement may cover several functions, create or replace is recognised, text in bodies and comments is ignored", () => {
  const sql = `-- create function public.commented() ...
create or replace function public.a(p uuid) returns void language plpgsql as $body$ begin execute 'create function public.dynamic()'; end $body$;
CREATE FUNCTION "public"."b"(p int) RETURNS int LANGUAGE sql AS $$ select 1 $$;
revoke all on function public.a(uuid), public.b(integer)
  from public, anon;
grant execute on function public.a(uuid), public.b(integer) to authenticated;
`;
  assert.deepEqual(checkFunctionGrants("m.sql", sql), []);
});

test("grants: an unqualified function counts as public", () => {
  assert.equal(checkFunctionGrants("m.sql", create("f")).length, 2);
});

test("secrets: flags credentials without echoing them", () => {
  const secret = "postgresql://postgres:hunter2hunter2@db.example.com:5432/postgres";
  const findings = checkSecrets("m.sql", `select 1;\n-- ${secret}\n`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
  assert.ok(!JSON.stringify(findings).includes("hunter2"));
  assert.equal(checkSecrets("m.sql", "select 'sb_secret_abcdefghijklmnop';").length, 1);
  assert.equal(checkSecrets("m.sql", "select 'sk-proj-abcdefghijklmnopqrstu';").length, 1);
  assert.equal(
    checkSecrets("m.sql", "select 'eyJhbGciOiJIUzI1NiIsInR5cCI6.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijkl';").length,
    1,
  );
  assert.deepEqual(
    checkSecrets("m.sql", "select 'postgres://localhost/db', 'task-list', 'desk-tools', 'sb_publishable_x';"),
    [],
  );
});

test("runGuards applies the function rule to added files only and secrets to every file", () => {
  const files = { [A]: create("public.old"), [B]: create("public.new"), [C]: "select 'sb_secret_abcdefghijklmnop';" };
  const changes = [{ status: "A", file: `supabase/migrations/${B}` }];
  const found = runGuards({ files, changes, baseNames: [A] });
  assert.deepEqual(rules(found).sort(), ["grants", "grants", "secrets"]);
  assert.ok(found.filter((f) => f.rule === "grants").every((f) => f.file.endsWith(B)));
  // Without a base the tree-only checks still run.
  assert.deepEqual(rules(runGuards({ files: { [A]: create("public.old") } })), []);
});

test("migration history: applied and release checks", () => {
  const row = (local, remote) => ({ local, remote });
  const rows = [row(A.slice(0, 14), A.slice(0, 14)), row(B.slice(0, 14), B.slice(0, 14))];
  assert.deepEqual(checkHistory(rows, "applied"), []);
  assert.equal(checkHistory([...rows, row(C.slice(0, 14), null)], "applied").length, 1);
  assert.equal(checkHistory([...rows, row(null, "20260101000000")], "applied").length, 1);
  // Release: pending is expected; the baseline must be recorded; no out-of-order pending.
  assert.deepEqual(checkHistory([...rows, row(C.slice(0, 14), null)], "release"), []);
  assert.match(checkHistory([row(A.slice(0, 14), null), row(B.slice(0, 14), null)], "release")[0], /baseline/);
  assert.match(
    checkHistory(
      [row(A.slice(0, 14), A.slice(0, 14)), row("20261110195000", null), row(B.slice(0, 14), B.slice(0, 14))],
      "release",
    )[0],
    /older than the newest/,
  );
  assert.equal(checkHistory(rows, "bogus").length, 1);
  assert.equal(checkHistory([], "applied").length, 1);
});

test("migration history parses the CLI's JSON, with empty values meaning absent", () => {
  const rows = parseMigrationList(
    JSON.stringify({
      migrations: [
        { local: "2", remote: "" },
        { local: "", remote: "1" },
        { local: "3", remote: null },
      ],
      message: "ok",
    }),
  );
  assert.deepEqual(rows, [
    { local: null, remote: "1" },
    { local: "2", remote: null },
    { local: "3", remote: null },
  ]);
  assert.equal(parseMigrationList("[]").length, 0);
  assert.throws(() => parseMigrationList("Connecting to local database..."), /not the JSON/);
  assert.throws(() => parseMigrationList("{}"), /no "migrations"/);
});

test("checkRepository diffs a real git history against a base ref", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "embel guard "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    run("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
    });
  await git("init", "-q", "-b", "main");
  await mkdir(path.join(root, "supabase/migrations"), { recursive: true });
  await mkdir(path.join(root, "supabase/archive"), { recursive: true });
  const put = (file, text) => writeFile(path.join(root, file), text);
  await put(`supabase/migrations/${A}`, "select 1;\n");
  await put(`supabase/migrations/${B}`, "select 2;\n");
  await put("supabase/archive/old.sql", "select 0;\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "base");

  await git("checkout", "-q", "-b", "good");
  await put(
    `supabase/migrations/${C}`,
    create("public.f") +
      "revoke all on function public.f(uuid) from public, anon, authenticated;\ngrant execute on function public.f(uuid) to service_role;\n",
  );
  await git("add", "-A");
  await git("commit", "-q", "-m", "add");
  const good = await checkRepository(root, "main");
  assert.deepEqual(good.findings, []);
  assert.equal(good.added, 1);

  await git("checkout", "-q", "-b", "bad", "main");
  await put(`supabase/migrations/${A}`, "select 'changed';\n");
  await run("rm", [path.join(root, `supabase/migrations/${B}`)]);
  await put("supabase/archive/new.sql", "select 9;\n");
  await put("supabase/migrations/20261110195000_late.sql", create("public.g"));
  await git("add", "-A");
  await git("commit", "-q", "-m", "bad");
  const bad = await checkRepository(root, "main");
  assert.deepEqual(rules(bad.findings).sort(), ["archive", "grants", "grants", "history", "history", "names"]);
});
