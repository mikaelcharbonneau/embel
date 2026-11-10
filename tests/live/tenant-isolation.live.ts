import { beforeAll, describe, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readLiveConfig } from "./gate";

// Deliberately separate from ordinary tests; never loads an env file or creates users.
const config = readLiveConfig(process.env);
const fixtureVersionSchema = z.object({
  id: z.uuid(),
  owner_id: z.uuid(),
  project_id: z.uuid(),
  asset_id: z.uuid(),
  storage_path: z.string(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  provenance: z.object({ fixture: z.literal("fluid-live-isolation-v1") }),
});
type FixtureVersion = z.infer<typeof fixtureVersionSchema>;
type Actor = { client: SupabaseClient; userId: string; projectId: string; version: FixtureVersion };

function check(condition: unknown, message: string): asserts condition {
  // Avoid assertion diffs: user records, tokens and signed URLs must never reach logs.
  if (!condition) throw new Error(message);
}

async function safeCall<T>(label: string, run: () => PromiseLike<T>): Promise<T> {
  try {
    return await run();
  } catch {
    throw new Error(`${label} failed; inspect the service securely outside the test log.`);
  }
}

const boundedFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error("Live test transport failed.");
  }
};

function clientFor(token?: string) {
  check(config, "Live tests are disabled.");
  return createClient(config.url, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: boundedFetch, headers: token ? { Authorization: `Bearer ${token}` } : {} },
  });
}

async function loadActor(fixture: { token: string; projectId: string; versionId: string }): Promise<Actor> {
  const client = clientFor(fixture.token);
  const auth = await safeCall("Identity verification", () => client.auth.getUser(fixture.token));
  check(
    !auth.error && auth.data.user && !auth.data.user.is_anonymous,
    "A dedicated non-anonymous test session is required.",
  );
  const userId = auth.data.user.id;
  const project = await safeCall("Own project read", () =>
    client.from("projects").select("id,owner_id").eq("id", fixture.projectId).single(),
  );
  check(!project.error && project.data?.owner_id === userId, "Test project is missing or has a different owner.");
  const versionResult = await safeCall("Own version read", () =>
    client
      .from("asset_versions")
      .select("id,owner_id,project_id,asset_id,storage_path,content_hash,provenance")
      .eq("id", fixture.versionId)
      .single(),
  );
  const parsed = fixtureVersionSchema.safeParse(versionResult.data);
  check(!versionResult.error && parsed.success, "A dedicated, labelled live Storage fixture is required.");
  const version = parsed.data;
  check(
    version.owner_id === userId && version.project_id === fixture.projectId,
    "Live fixture ownership is inconsistent.",
  );
  check(
    version.storage_path === `${userId}/${fixture.projectId}/${version.asset_id}/${version.id}`,
    "Live fixture Storage path is inconsistent.",
  );
  return { client, userId, projectId: fixture.projectId, version };
}

describe.skipIf(!config)("live Supabase two-user read isolation (preconfigured development fixtures)", () => {
  let a: Actor;
  let b: Actor;
  let anonymous: SupabaseClient;

  beforeAll(async () => {
    check(config, "Live tests are disabled.");
    a = await loadActor(config.a);
    b = await loadActor(config.b);
    check(a.userId !== b.userId, "The two verified test sessions belong to the same identity.");
    anonymous = clientFor();
  });

  it("lets both verified owners read their own project revisions", async () => {
    for (const actor of [a, b]) {
      const result = await safeCall("Own revisions read", () =>
        actor.client
          .from("project_revisions")
          .select("project_id,owner_id,revision")
          .eq("project_id", actor.projectId)
          .limit(5),
      );
      check(!result.error && result.data && result.data.length > 0, "Owned project revisions were not readable.");
      check(
        result.data.every((row) => row.owner_id === actor.userId),
        "An owned revision query returned a different owner.",
      );
    }
  });

  it("hides projects, revisions, assets and versions across both tenant directions", async () => {
    for (const [viewer, owner] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const [table, column, id] of [
        ["projects", "id", owner.projectId],
        ["project_revisions", "project_id", owner.projectId],
        ["assets", "id", owner.version.asset_id],
        ["asset_versions", "id", owner.version.id],
      ]) {
        const result = await safeCall("Cross-owner read", () =>
          viewer.client.from(table!).select("owner_id").eq(column!, id!),
        );
        check(!result.error && result.data?.length === 0, "A cross-owner database read was not isolated.");
      }
    }
  });

  it("downloads each owner's labelled private object with its recorded content hash", async () => {
    for (const actor of [a, b]) {
      const result = await safeCall("Own private download", () =>
        actor.client.storage.from("fluid-assets").download(actor.version.storage_path),
      );
      check(!result.error && result.data, "Owned private fixture download failed.");
      check(result.data.size > 0 && result.data.size <= 16384, "Live fixture must be a small nonempty test file.");
      const digest = createHash("sha256")
        .update(new Uint8Array(await result.data.arrayBuffer()))
        .digest("hex");
      check(
        digest === actor.version.content_hash,
        "Downloaded fixture content does not match its immutable version hash.",
      );
    }
  });

  it("denies cross-owner downloads and signed URLs", async () => {
    for (const [viewer, owner] of [
      [a, b],
      [b, a],
    ] as const) {
      const download = await safeCall("Cross-owner download", () =>
        viewer.client.storage.from("fluid-assets").download(owner.version.storage_path),
      );
      check(
        !download.data && download.error && [400, 401, 403, 404].includes(download.error.status ?? 0),
        "A cross-owner download was not denied by Storage.",
      );
      const signed = await safeCall("Cross-owner URL signing", () =>
        viewer.client.storage.from("fluid-assets").createSignedUrl(owner.version.storage_path, 30),
      );
      check(
        !signed.data && signed.error && [400, 401, 403, 404].includes(signed.error.status ?? 0),
        "A cross-owner signed URL was not denied by Storage.",
      );
    }
  });

  it("denies anonymous database access and public object downloads", async () => {
    const result = await safeCall("Anonymous project read", () =>
      anonymous.from("projects").select("id").eq("id", a.projectId),
    );
    check(
      !result.data && result.error?.code === "42501",
      "Anonymous project access was not denied by database grants.",
    );
    for (const actor of [a, b]) {
      const { data } = anonymous.storage.from("fluid-assets").getPublicUrl(actor.version.storage_path);
      const response = await safeCall("Public download denial", () => boundedFetch(data.publicUrl));
      await response.body?.cancel();
      check(
        [400, 401, 403, 404].includes(response.status),
        "A private fixture was accessible through the public Storage route.",
      );
    }
  });
});
