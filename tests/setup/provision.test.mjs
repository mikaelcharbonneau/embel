import assert from "node:assert/strict";
import { test } from "node:test";
import { developmentTargetSql, HTTP_LANES } from "../../scripts/development/provision.mjs";

test("the local target keeps production's check on the default API port and widens it elsewhere", () => {
  const standard = developmentTargetSql("http://127.0.0.1:54321");
  assert.ok(standard.includes("'http://127.0.0.1:54321'<>'http://127.0.0.1:54321'"));
  assert.ok(standard.includes("select 'development','http://127.0.0.1:54321' where not exists"));
  const other = developmentTargetSql("http://127.0.0.1:55321");
  assert.ok(other.includes("alter table fluid_private.shared_http_target drop constraint shared_http_target_check"));
  assert.ok(other.includes("origin~'^http://127\\.0\\.0\\.1:[0-9]{4,5}$'"));
  assert.throws(() => developmentTargetSql("https://example.com"), /Invalid local API origin/);
  assert.throws(() => developmentTargetSql("http://127.0.0.1:5432'; drop table x; --"), /Invalid local API origin/);
});

test("the web lanes use the login roles the baseline creates", () => {
  assert.deepEqual(
    HTTP_LANES.map((lane) => lane.roleName),
    ["embel_shared_http_identity_prod_v1", "embel_shared_http_home_prod_v1", "embel_shared_http_logo_prod_v1"],
  );
  assert.deepEqual(
    [...new Set(HTTP_LANES.map((lane) => lane.registry))],
    ["shared_http_principals", "shared_logo_http_principals"],
  );
});
