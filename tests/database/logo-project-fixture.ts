import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { logoMutationReceiptSchema, type LogoWorkspaceV2 } from "../../src/domain/logo-workspace";
import type { ContextSnapshot } from "../../src/domain/projects";
import { reviewedStrategy } from "../fixtures/reviewed-strategy";
import { asRole, OWNER_A, type TestDatabase } from "./local-supabase";

/** Runs one SQL statement as the signed-in owner and returns the `value`
 * column of its first row. Each harness keeps its own way of signing in. */
export type OwnerQuery = (sql: string, params: unknown[]) => Promise<unknown>;

/** Owner queries through the plain local `authenticated` role. */
export function ownerQuery(db: TestDatabase, owner: string = OWNER_A): OwnerQuery {
  return (sql, params) =>
    asRole(db, "authenticated", owner, async () => (await db.query<{ value: unknown }>(sql, params)).rows[0]!.value);
}

/** A complete brand whose Logo step has its first brief saved, made the way the
 * app makes it: create the project, open its Logo workspace, then save the
 * brief. Every project is a complete brand, so tests no longer start a
 * logo-only project. `requestKey` is the brief save's request key; the brief
 * is checked by the database, as an app save would be. */
export async function startLogoFixture(
  query: OwnerQuery,
  input: { requestKey?: string; brief: { name: string; [field: string]: unknown } },
  context: ContextSnapshot = reviewedStrategy(),
): Promise<LogoWorkspaceV2> {
  const name = input.brief.name.trim(),
    title = name.length >= 1 && [...name].length <= 160 ? name : "Logo fixture";
  const contextJson = JSON.stringify(context),
    hash = createHash("sha256").update(contextJson).digest("hex");
  const projectId = z
    .uuid()
    .parse(
      await query("select (public.create_project('complete_brand',$1,$2::jsonb,$3)).id value", [
        title,
        contextJson,
        hash,
      ]),
    );
  const heads = z
    .object({ heads: z.unknown() })
    .parse(await query("select public.get_logo_workspace($1) value", [projectId])).heads;
  const body = { requestKey: input.requestKey ?? randomUUID(), expected: heads, brief: input.brief };
  return logoMutationReceiptSchema.parse(
    await query("select public.initialize_existing_brand_logo($1,$2::jsonb) value", [projectId, JSON.stringify(body)]),
  ).workspace;
}
